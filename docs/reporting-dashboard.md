# Contrato da API de relatórios e painel — PRA-29 / PRA-61

## Objetivo

Este incremento cria a primeira superfície de consulta dos marts homologados sem
expor as abas raw, credenciais ou detalhes de pedidos. O mesmo contrato atende:

- o painel HTML carregado pelo Apps Script;
- chamadas server-side por `google.script.run`;
- a rota JSON explícita do Web App.

A interface é de homologação administrativa. Ela não substitui o dashboard final
nem altera a implantação ativa automaticamente.

## Rotas e entradas

| Entrada | Uso | Compatibilidade |
| --- | --- | --- |
| `doGet()` sem parâmetros | Saúde legada | Preservada sem alteração de formato |
| `?view=dashboard` | Renderiza `Index.html` | Nova |
| `?resource=health` | Saúde no envelope v1 | Nova |
| `?resource=dashboard` | Indicadores no envelope v1 | Nova |
| `?resource=kpis` | Totais confirmados do período | Incremento de leitura |
| `?resource=trend` | Série diária confirmada | Incremento de leitura |
| `?resource=products` | Ranking por produto ou família | Incremento de leitura |
| `?resource=variations` | Ranking das variações conhecidas | Incremento de leitura |
| `?resource=suppliers` | Ranking por fornecedor atual | Incremento de leitura |
| `getDashboardSnapshot(filters)` | Bridge do HTML | Nova |

Filtros aceitos pelo recurso `dashboard`:

| Filtro | Regra |
| --- | --- |
| `startDate` / `start` | ISO `YYYY-MM-DD`; padrão: até 30 dias antes do último período confirmado |
| `endDate` / `end` | ISO `YYYY-MM-DD`; padrão: último período confirmado |
| `view` / `granularity` | `product` ou `parent`; nunca são somados |
| `supplierId` / `supplier_id` | ID técnico positivo e opcional; fornecedor atual |
| `limit` | Inteiro de 1 a 50; padrão 10 |

O intervalo é inclusivo e limitado a 366 dias.
No recurso `dashboard`, `supplierId` filtra somente o ranking; os KPIs e a
série continuam mostrando os totais gerais do período. O painel informa essa
distinção quando o filtro é aplicado.

Os recursos `kpis` e `trend` aceitam somente o período: o mart de KPIs não
contém um total de pedidos distintos por fornecedor. `supplierId`, `view` e
`limit` são recusados com `report_filter_unsupported`. O recurso `products`
aceita todos os filtros acima. `variations` e `suppliers` exigem
`view=product` (padrão) para
evitar a duplicação da visão de famílias. Eles aceitam período, fornecedor e
limite. Uma variação é identificada por `stg_products.is_variation`; itens de
produto desconhecido não são adivinhados como variação. `suppliers` devolve
`supplierId`, quantidade, faturamento e `knownProductsCount` (IDs conhecidos
distintos), sem somar `orders_count` de produtos diferentes. Fornecedor sem vínculo aparece
com `supplierId: null`. Itens sem ID entram nos totais, mas não na contagem de
produtos conhecidos. A atribuição é a atual, nunca histórica.

As novas rotas devolvem o mesmo envelope v1 e preservam o recurso `dashboard`.
Elas não exportam CSV nesta etapa; exportação e homologação do Web App são
entregas separadas.

## Envelope v1

Toda rota nova responde com as quatro propriedades abaixo, inclusive em falha:

```json
{
  "data": {},
  "meta": {
    "contractVersion": "1.0",
    "generatedAt": "2026-09-14T00:00:00.000Z",
    "source": "confirmed_marts"
  },
  "filtersApplied": {
    "startDate": "2026-09-01",
    "endDate": "2026-09-11",
    "view": "product",
    "supplierId": null,
    "limit": 10
  },
  "errors": []
}
```

`data` contém somente agregados:

- `kpis`: faturamento, pedidos válidos, quantidade e ticket médio;
- `trend`: série diária confirmada;
- `rankings`: produto ou família, nunca ambos;
- `quality`: contagens de erros e janelas, sem chaves das entidades;
- `operations`: último cálculo, última sincronização segura e triggers;
- `meta.runtime`: revisão e hash do pacote gerado.

Nas rotas especializadas, `data` contém apenas a chave do recurso solicitado:
`kpis`, `trend`, `products`, `variations` ou `suppliers`. O dashboard mantém
`rankings`, `quality` e `operations` no mesmo envelope.

O ticket médio do intervalo é `faturamento total / pedidos válidos totais`, não
uma média simples dos tickets diários.

## Erros estáveis

| Código | Situação |
| --- | --- |
| `report_invalid_start_date` | Data inicial inválida |
| `report_invalid_end_date` | Data final inválida |
| `report_invalid_date_range` | Início posterior ao fim |
| `report_range_too_large` | Mais de 366 dias |
| `report_invalid_view` | Visão diferente de `product`/`parent` |
| `report_invalid_supplier` | Fornecedor inválido |
| `report_invalid_limit` | Limite fora de 1–50 |
| `report_filter_unsupported` | Filtro de ranking informado para KPI ou série |
| `report_source_busy` | Job de escrita mantém o lock |
| `report_source_unavailable` | Aba analítica ausente |
| `report_schema_mismatch` | Cabeçalho incompatível |
| `report_unknown_resource` | Recurso HTTP desconhecido |
| `report_internal_error` | Falha inesperada, sem detalhes internos |

Falhas inesperadas são registradas apenas pelo código estável. Mensagens privadas,
IDs de pedidos, payloads, preços de custo e credenciais não entram na resposta.

## Consistência

A consulta obtém o mesmo lock usado pelos jobs de escrita. Somente dias presentes
em `mart_period_state` entram em KPI, série e ranking. Isso impede que o painel
leia uma fotografia intermediária enquanto várias abas estão sendo substituídas.

`mart_product_sales` contém visões duplicadas por desenho. O filtro `view` escolhe
exatamente um prefixo de `mart_key` antes de agregar.

## Interface

`src/ui/Index.html` não acessa o Google Sheets diretamente. Ele chama somente
`getDashboardSnapshot()` e cobre:

- filtros de período, visão e fornecedor;
- cards de KPI;
- série temporal em SVG sem biblioteca externa;
- ranking com barras proporcionais;
- qualidade e janelas pendentes;
- revisão, hash e triggers;
- loading, vazio, falha e layout responsivo.

Fora do Apps Script, a página exibe dados sintéticos e um aviso explícito para
permitir inspeção visual. Esse fallback nunca é usado quando `google.script.run`
está disponível.

## Build e implantação

O builder inclui `.gs`, manifesto e `.html` no hash da fonte. Ele grava
`Runtime.gs`, `appsscript.json` e cada HTML pelo nome base na pasta de saída.
Nomes HTML duplicados são recusados, pois o Apps Script usa um namespace plano.

Procedimento:

1. executar `npm run check`;
2. gerar com `npm run build:runtime -- /pasta/de/saida`;
3. conferir revisão sem `+dirty`, hash, quantidade de módulos e HTMLs;
4. substituir integralmente `Runtime.gs` e criar/atualizar `Index.html` no projeto existente;
5. manter o manifesto e as Script Properties aprovados;
6. validar `?resource=dashboard` antes de abrir `?view=dashboard`;
7. comparar os totais exibidos com `mart_kpis`, usando apenas um nível de ranking;
8. criar nova versão Web App somente após homologação e autorização de publicação.
