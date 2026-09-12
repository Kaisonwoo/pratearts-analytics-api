# Regra de venda válida: Atendido

A implementação de PRA-24 / US-018 e PRA-59 / TT-018 define uma única regra para decidir quais pedidos podem compor indicadores comerciais do MVP.

## Fonte da regra

A classificação usa exclusivamente o ID técnico configurado em `BLING_STATUS_ATENDIDO_ID`.

Esse valor deve ser preenchido com o ID da situação **Atendido** previamente validado no Bling. O código não compara o nome da situação e não possui um ID comercial real hard-coded.

Antes de classificar pedidos, o serviço valida que a configuração contém uma string numérica positiva. Configuração ausente ou inválida interrompe a classificação para evitar publicar indicadores com uma regra ambígua.

## Classificação

`PRAValidSalesService` lê `stg_orders` e atualiza `is_valid_sale` por pedido:

- `true` quando `status_id === BLING_STATUS_ATENDIDO_ID`;
- `false` para qualquer outra situação, inclusive status ausente ou inválido já sinalizado pela normalização.

Nenhum pedido é removido do staging. Isso mantém as contagens auditáveis por `order_id` e permite conferir quais registros foram incluídos ou excluídos.

## Transições após reconciliação

A reconciliação histórica pode reenfileirar um pedido já processado quando seu estado muda no Bling. O detalhe atualizado substitui o registro raw anterior pela mesma chave.

Na execução seguinte de `runOrdersNormalization()`:

1. o `TransformService` reconstrói o pedido no staging com o `status_id` atual;
2. o `PRAValidSalesService` recalcula `is_valid_sale`;
3. um pedido que saiu de Atendido passa de `true` para `false` e deixa de ser elegível para os futuros KPIs.

O inverso também é suportado: um pedido que passe posteriormente para Atendido torna-se válido na próxima classificação.

## Contagens seguras

O serviço retorna e registra somente:

- quantidade de pedidos avaliados;
- quantidade de pedidos válidos;
- quantidade de pedidos excluídos;
- identificador técnico da execução.

IDs de pedidos, valores, SKUs e outros dados comerciais não são enviados aos logs.

## Execução

- `runOrdersNormalization()` normaliza os dados e aplica a regra de venda válida em sequência.
- `runValidSalesClassification()` reaplica somente a regra sobre o staging atual.

As histórias de métricas e marts devem considerar apenas pedidos com `is_valid_sale = true`.
