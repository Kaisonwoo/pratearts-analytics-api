# Marts analíticos incrementais — PRA-30 / PRA-63

## Contrato e escopo

`runMartsBuild()` prepara `stg_products`, calcula `mart_kpis` e
`mart_product_sales` e confirma as janelas de recálculo concluídas. O mesmo job
é chamado por `runDailySync()` após normalização, faturamento por item e venda
válida. Este incremento prepara a base dos relatórios; ainda não cria telas
nem endpoints de consulta de indicadores.

O esquema 3 acrescenta `mart_period_state` sem alterar os cabeçalhos anteriores.
São 15 abas de dados/controle, mais `_schema_registry`. Execute
`provisionDataLayers()` antes de usar o novo runtime. A gravação amplia a grade
de destino quando necessário, sem apagar linhas ou dados da origem.

## Granularidade e fórmulas

`period_key` é o dia do pedido no formato `YYYY-MM-DD`; início e fim são
inclusivos. `mart_kpis` contém uma linha por dia com pedidos válidos distintos,
quantidade, faturamento e ticket médio. Reutiliza `PRAKpiService`, incluindo
desconto percentual do item, arredondamento monetário e quantidades negativas.
Para um intervalo, some faturamento e pedidos diários e divida esses totais:
nunca faça a média simples dos tickets diários. Datas sem pedidos são esparsas;
uma data antes preenchida e depois esvaziada recebe totais zero.

`mart_product_sales` contém duas visões, identificadas por `mart_key`:

| Prefixo | Agrupamento | Uso |
| --- | --- | --- |
| `product:` | Dia, ID de produto, SKU e fornecedor atual | Produto e variação vendidos |
| `parent:` | Dia, ID do pai e fornecedor atual | Família consolidada; sem pai, usa o próprio produto |

Selecione **um único prefixo** antes de somar quantidade ou faturamento. Somar
as duas visões duplicaria os valores. Cada grupo conta pedidos distintos, mas
`orders_count` não é aditivo entre produtos, fornecedores ou famílias: o mesmo
pedido pode aparecer em vários grupos. Relatórios que exigirem pedidos
distintos em agrupamentos diferentes devem usar a origem por pedido; os
contadores já agregados não permitem essa deduplicação.

SKUs iguais com IDs diferentes permanecem separados. Itens sem cadastro de
produto são mantidos por SKU ou chave do item, sem desaparecer dos totais.
Hierarquias circulares ou com mais de um nível de pai bloqueiam o cálculo.

## Fornecedor atual e exceções

A atribuição usa exclusivamente o fornecedor principal já reconciliado em
`stg_product_suppliers`, conforme a regra configurada. Não há junção com todos
os vínculos brutos nem herança implícita do fornecedor do pai. Trocar o
fornecedor atual reatribui as vendas históricas do produto nos marts.

Ausência e multiplicidade permanecem identificáveis por `link_state` nessa
aba. Os resumos do job contam itens válidos sem fornecedor ou com múltiplos
vínculos nos dias recalculados; não incluem nomes, IDs de fornecedor ou valores
comerciais. Ausência mantém `supplier_id` vazio. Anomalias de vínculos já
quarentenadas em `data_quality_errors` são preservadas. Uma futura tela deve
explicitar **fornecedor atual, não histórico**, e oferecer acesso às exceções.

## Incrementalidade e recuperação

O estado de cada dia registra hashes SHA-256 da entrada semântica e da saída,
além de data e `run_id`. Novos pedidos, cancelamentos, mudança de data,
quantidade, faturamento, pai ou fornecedor invalidam os dias afetados.
Mudanças apenas em timestamps de reprocessamento não refazem os indicadores.
Saída adulterada ou parcialmente gravada também é detectada na próxima execução.

Uma janela `pending` força recálculo dos seus dias. Só muda para `completed`
quando todos os dias afetados estiverem confirmados. `waiting_details`, filas
pendentes, checkpoints de coleta, erros de detalhes e staging incompatível
bloqueiam a publicação. Janelas sem pedidos podem concluir sem inventar vendas.

Por padrão, cada lote calcula até 30 dias alterados, com prazo compartilhado de
execução e margem de 30 segundos para persistência. O limite programático vai
de 1 a 366 dias. Um lock serializa leitura, cálculo e escrita. Quando necessário,
`runMartsContinuation()` agenda uma única continuação; no fluxo diário, esse
papel fica exclusivamente com `runDailySyncContinuation()`.

O agendador compartilhado permite explicitamente os dois handlers e mantém
deduplicação e cancelamento isolados por nome. Falhas de agendamento preservam
no resumo os períodos já gravados e o bloqueio original, quando existente;
a retomada usa os hashes persistidos e não exige limpar ou reiniciar a base.
O teste de integração carrega o agendador real, incluindo a falha após a escrita.

Os hashes de saída usam os tipos lógicos do esquema: IDs/SKUs como texto,
datas como ISO e métricas como número. Isso evita recalcular indefinidamente
quando o Sheets devolve um ID numérico gravado como string. Após o flush, o job
relê os marts e compara os hashes antes de confirmar estado e janelas. Conversão
com perda de conteúdo (por exemplo, SKU com zeros iniciais) retorna
`mart_persisted_output_mismatch` e interrompe a continuação para diagnóstico.

O recálculo é incremental **por período**, mas a implementação atual ainda lê
as tabelas completas e grava em lote a fotografia completa de cada destino
alterado, preservando os valores dos períodos intactos. O custo físico cresce
com a base. A margem de tempo é cooperativa e não interrompe uma chamada
remota já iniciada; desempenho e cotas precisam de homologação no Apps Script.

As saídas são gravadas com restauração em caso de exceção capturável e `flush()`
antes da confirmação de hashes e janelas. Google Sheets não oferece uma
transação atômica entre essas abas: interrupção abrupta pode deixar uma
fotografia incompleta até a retomada. Estado antigo ou hash divergente obriga
reparo. Futuros consumidores devem recusar saída não confirmada, usando o mesmo
lock e verificando estado/hash; ler diretamente as abas durante um job não é
um contrato de leitura consistente. Falhas de armazenamento retornam bloqueio
para diagnóstico e retomada manual; não entram em repetição automática ilimitada.

## Empacotamento e homologação

1. Execute `npm run check` no commit a publicar.
2. Gere o pacote com `npm run build:runtime -- /caminho/temporario/runtime`.
   O gerador inclui automaticamente todos os `.gs` de `src/`, valida sintaxe e
   informa revisão e hash do conteúdo, incluindo manifesto. `+dirty` indica
   fonte com alterações ainda não commitadas e não deve ser implantada como
   release. Preserve as propriedades existentes do Apps Script.
3. Após a integração aprovada, implante o runtime consolidado e seu manifesto;
   elimine funções duplicadas de arquivos antigos conforme o procedimento
   operacional existente. Não execute o gerador antigo de lista manual.
4. Execute `healthCheck()`, `provisionDataLayers()` e confirme versão 3 e
   preservação das contagens de origem. Se houver fila/checkpoint ativo,
   conclua a coleta antes de prosseguir.
5. Execute `runOrdersNormalization()` e `runMartsBuild()`. Aguarde as
   continuações até `completed`, sem resetar checkpoints ou apagar abas.
6. Confira diariamente os totais com staging elegível, selecione cada prefixo
   separadamente e compare seus totais com `mart_kpis`. Verifique `stg_products`,
   estado por período e conclusão das janelas. Registre apenas contagens e
   resultados da conferência no Jira e Documento Vivo.
7. Repita sem alterar a origem: `periodsWritten` deve ser zero. Só conclua
   PRA-30/PRA-63 após CI, integração e evidência no ambiente real.

Os testes locais usam exclusivamente dados sintéticos e cobrem falhas entre
abas, falha de checkpoint, corrupção de saída, bloqueios, limite de tempo,
expansão da grade, idempotência, cancelamentos e regras de agrupamento. São
evidência funcional; não substituem a homologação no ambiente Google.

Referências: [Sheet — linhas e intervalos](https://developers.google.com/apps-script/reference/spreadsheet/sheet)
e [SpreadsheetApp.flush](https://developers.google.com/apps-script/reference/spreadsheet/spreadsheet-app#flush()).
