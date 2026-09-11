# Coleta de produtos e relações pai/filho

Documento técnico da US-012/PRA-16 e da tarefa TT-012/PRA-53.

## Coleta retomável

`PRAProductsSyncJob.run` percorre `GET /produtos` com `pagina` e `limite`,
respeitando o ritmo, o backoff e o limite de páginas do cliente Bling. Cada
página é persistida antes do avanço do checkpoint. Uma falha HTTP, de contrato
ou de armazenamento mantém a próxima página inalterada para retomada segura.

O checkpoint contém somente run ID, página e contagens. Produtos, nomes, SKUs,
preços e payloads não são gravados nas Script Properties nem nos logs.

## Normalização e persistência

A aba `raw_products` é criada na planilha indicada por `DATA_SPREADSHEET_ID`.
Cada produto é identificado por `product_id`, preserva o SKU em `sku` e usa
`parent_product_id` para a relação pai/filho. Produtos simples ou pais mantêm
esse campo vazio e continuam disponíveis individualmente por seu próprio ID.

As reexecuções substituem linhas existentes pela chave `product_id`, evitando
duplicidades. O relacionamento aceita `idProdutoPai` da listagem e também o
campo aninhado `variacao.produtoPai.id` presente no contrato de detalhes.

## Execução

1. Confirme que `DATA_SPREADSHEET_ID` aponta para a planilha operacional.
2. Execute `runProductsSync(true)` para iniciar uma reconciliação completa.
3. Se o retorno for `in_progress`, execute `runProductsSync(false)` até receber
   `products_sync_completed`.

O retorno público contém somente páginas, quantidades, relações encontradas,
estado, horários e run ID.

## Segurança

A rotina usa exclusivamente `GET /produtos`. Nenhum token, credencial, produto,
SKU, nome, preço ou payload aparece em logs ou respostas públicas.
