# Mapeamento da API do Bling

Documento técnico da US PRA-9 e da tarefa PRA-44. O mapeamento foi conferido em 9 de setembro de 2026 na [referência OpenAPI oficial do Bling](https://developer.bling.com.br/referencia). A matriz consumível por código está em [`config/bling-read-model.json`](../config/bling-read-model.json).

## Objetivo e limites

O MVP consulta apenas operações `GET` da API v3. Nenhuma operação cria, altera ou exclui dados no Bling. Todas as respostas mapeadas usam o envelope `data` e a URL base `https://api.bling.com.br/Api/v3`.

Listagens paginadas usam `pagina` e `limite`. A integração adotará `limite=100`, conforme as [boas práticas oficiais](https://developer.bling.com.br/boas-praticas), e percorrerá as páginas até a resposta não apresentar mais registros.

## Matriz de endpoints

| Recurso | Endpoint | Uso no MVP | Estratégia |
|---|---|---|---|
| Pedidos de venda | `GET /pedidos/vendas` | Descobrir pedidos e alterações | Incremental por `dataAlteracaoInicial` e `dataAlteracaoFinal` |
| Detalhe do pedido | `GET /pedidos/vendas/{idPedidoVenda}` | Obter itens, valores e vínculos com produtos | Uma consulta por pedido novo ou alterado |
| Produtos | `GET /produtos` | Catálogo, SKU e relação pai/filho | Reconciliação completa paginada |
| Detalhe do produto | `GET /produtos/{idProduto}` | Complementar atributos do produto | Uma consulta por produto selecionado |
| Produto com variações | `GET /produtos/variacoes/{idProdutoPai}` | Confirmar pai, filhos e ordem das variações | Uma consulta por produto pai |
| Produto-fornecedor | `GET /produtos/fornecedores` | Relacionar produtos e fornecedores | Reconciliação completa paginada |
| Detalhe produto-fornecedor | `GET /produtos/fornecedores/{idProdutoFornecedor}` | Complementar garantia, se necessária | Sob demanda |
| Saldos de estoque | `GET /estoques/saldos` | Saldo total e por depósito | Lotes de IDs de produtos |
| Saldo por depósito | `GET /estoques/saldos/{idDeposito}` | Auditoria pontual de depósito | Sob demanda |
| Módulos de situações | `GET /situacoes/modulos` | Descobrir o módulo de vendas | Configuração inicial e reconciliação |
| Situações do módulo | `GET /situacoes/modulos/{idModuloSistema}` | Resolver o ID real de `Atendido` | Configuração inicial e reconciliação |

Os filtros e campos completos selecionados para cada recurso estão versionados em [`config/bling-read-model.json`](../config/bling-read-model.json).

## Chaves e relacionamentos

| Origem | Campo | Destino | Regra |
|---|---|---|---|
| Pedido detalhado | `itens[].produto.id` | Produto `id` | Chave principal entre item vendido e cadastro de produto |
| Pedido detalhado | `itens[].codigo` | Produto `codigo` | SKU registrado no momento do pedido; preservado como evidência histórica |
| Produto filho | `idProdutoPai` | Produto pai `id` | Identifica a variação e seu produto pai |
| Produto com variações | `variacoes[].variacao.produtoPai.id` | Produto pai `id` | Confirma o relacionamento no detalhe de variações |
| Produto-fornecedor | `produto.id` | Produto `id` | Permite agregar quantidade e faturamento por fornecedor |
| Produto-fornecedor | `fornecedor.id` | Dimensão de fornecedor | Identificador técnico do fornecedor |
| Estoque | `produto.id` | Produto `id` | Relaciona saldos ao catálogo |

O `id` do Bling é a chave técnica. O SKU está no campo `codigo`; ele é relevante para conferência humana e integração, mas não substitui o ID. Produtos com `formato=V` possuem variações. Na listagem, o filho informa `idProdutoPai`; no detalhe do pai, `variacoes[]` enumera os filhos.

## Regra de venda válida

Somente pedidos em situação **Atendido** entram nos indicadores. O ID dessa situação não será fixado no código, porque ele deve ser resolvido na conta da Pratearts:

1. Consultar `GET /situacoes/modulos` e localizar o módulo de vendas.
2. Consultar `GET /situacoes/modulos/{idModuloSistema}`.
3. Localizar a situação cujo `nome` normalizado seja `Atendido`.
4. Persistir o ID como configuração e usá-lo no filtro `idsSituacoes[]` de pedidos.
5. Falhar de forma explícita se nenhuma situação ou mais de uma situação compatível for encontrada.

O ID `91002001` usado nas amostras é inteiramente sintético e nunca deve ser usado em produção.

## Campos mínimos por domínio

### Pedidos e itens

- Pedido: `id`, `numero`, `numeroLoja`, `data`, `dataSaida`, `totalProdutos`, `total`, `situacao.id` e `loja.id`.
- Item: `id`, `codigo`, `descricao`, `unidade`, `quantidade`, `desconto`, `valor` e `produto.id`.
- A busca incremental usa as datas de alteração. A data de negócio dos relatórios permanece `data`, conforme decisão do MVP.

### Produtos e variações

- Produto: `id`, `idProdutoPai`, `nome`, `codigo`, `preco`, `precoCusto`, `situacao` e `formato`.
- Variação: `id`, `codigo`, `variacao.nome`, `variacao.ordem` e `variacao.produtoPai.id`.
- Valores de `formato`: `S` para simples, `V` para produto com variações e `E` para composição.

### Fornecedores

- Vínculo: `id`, `codigo`, `padrao`, `precoCusto`, `precoCompra`, `produto.id` e `fornecedor.id`.
- Quando houver mais de um vínculo, o relatório usará inicialmente o registro `padrao=true`. Ambiguidades deverão ser registradas para validação administrativa.

### Estoque

- Produto: `produto.id` e `produto.codigo`.
- Totais: `saldoFisicoTotal` e `saldoVirtualTotal`.
- Depósito: `depositos[].deposito.id`, `depositos[].saldoFisico` e `depositos[].saldoVirtual`.

## Amostras anonimizadas

Os arquivos em [`docs/samples/bling`](samples/bling) são contratos sintéticos para testes e desenvolvimento:

- [`sales-order-list.json`](samples/bling/sales-order-list.json)
- [`sales-order-detail.json`](samples/bling/sales-order-detail.json)
- [`product-list.json`](samples/bling/product-list.json)
- [`product-detail-with-variations.json`](samples/bling/product-detail-with-variations.json)
- [`product-supplier-list.json`](samples/bling/product-supplier-list.json)
- [`stock-balance.json`](samples/bling/stock-balance.json)
- [`situations.json`](samples/bling/situations.json)

IDs, SKUs, nomes, datas e valores são fictícios. Os exemplos não contêm clientes, endereços, documentos, telefones, e-mails, credenciais nem dados comerciais da Pratearts.

## Critérios de implementação para a próxima etapa

- Desembrulhar sempre `response.data` antes da normalização.
- Repetir chamadas paginadas com limite conhecido e parada determinística.
- Tratar `429` e erros transitórios com retentativa e espera progressiva.
- Preservar o payload bruto anonimizado somente em testes; em produção, restringir logs a IDs, contagens e contexto operacional.
- Renovar o token por meio do componente seguro já entregue, sem registrar credenciais.
- Reconciliar periodicamente pedidos antigos para capturar mudanças tardias.

## Evidência de aceite

- Matriz legível por código: `config/bling-read-model.json`.
- Contratos humanos e relações: este documento.
- Sete payloads JSON sintéticos e versionados.
- Testes automatizados verificando endpoints obrigatórios, método somente leitura, relacionamentos entre amostras e ausência de padrões comuns de dados sensíveis.
