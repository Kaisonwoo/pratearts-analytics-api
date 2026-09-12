# Coleta de detalhes e itens dos pedidos

Documento técnico da US-011/PRA-18 e da tarefa TT-011/PRA-51.

## Fluxo retomável

Cada página aceita pela carga inicial envia somente os IDs técnicos dos pedidos
para `PRAOrderDetailsQueue`. A fila é fragmentada por página para respeitar o
limite individual das Script Properties. Payloads, clientes, endereços e itens
não são gravados na fila.

`PRAOrderDetailsJob.run` consome até `BLING_MAX_ORDER_DETAILS_PER_RUN` IDs,
consulta `GET /pedidos/vendas/{idPedidoVenda}` e confirma a retirada da fila
somente depois da persistência. Falhas temporárias permanecem pendentes; falhas
permanentes são retiradas e registradas com código, status HTTP, número de
tentativas e correlation ID.

## Persistência mínima

O ID da planilha deve ser configurado em `DATA_SPREADSHEET_ID`. A primeira
execução cria e valida três abas:

- `raw_orders`: campos não pessoais necessários para identificar o pedido;
- `raw_order_items`: produto, SKU, quantidade, valor e desconto por item;
- `order_detail_errors`: evidência técnica de pedidos que não puderam ser lidos.

Pedidos são atualizados por `order_id`. Antes de gravar os itens atuais, os
itens anteriores do mesmo pedido são substituídos. Assim, uma reexecução não
duplica linhas e também remove itens que deixaram de existir na origem.

Pedidos, itens e erros são confirmados como um lote lógico. Uma falha em
qualquer aba restaura as abas já alteradas, preservando a última base válida.

## Execução

1. Execute novamente `runInitialOrdersLoad` para o período desejado depois de
   implantar esta versão; as páginas serão consultadas e os IDs serão enfileirados.
2. Execute `runOrderDetailsBatch`. O lote padrão contém 20 pedidos.
3. Repita enquanto o retorno for `in_progress`. O estado `completed` indica
   fila vazia; `completed_with_errors` indica falhas permanentes registradas.

Quando a fila fica vazia e `order_detail_errors` não possui falhas abertas, as
janelas históricas em `waiting_details` são promovidas para `pending`.

## Segurança

Retornos e logs contêm somente contagens, estado, horários, run ID e códigos de
erro. IDs de pedidos, SKUs, payloads, tokens, clientes e endereços não aparecem
nos logs operacionais nem nas respostas públicas.
