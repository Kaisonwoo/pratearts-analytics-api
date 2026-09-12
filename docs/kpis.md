# KPIs comerciais: faturamento, quantidade e ticket médio

A implementação de PRA-25 / US-021 e PRA-65 / TT-021 estabelece uma definição única para os KPIs comerciais usados pelos futuros marts, relatórios e dashboard.

## Fontes elegíveis

Os cálculos usam somente as tabelas de staging já normalizadas:

- `stg_orders`, com a classificação `is_valid_sale` produzida pelo `PRAValidSalesService`;
- `stg_order_items`, com quantidade, valor unitário e desconto do item.

Somente itens cujo `order_id` pertence a um pedido com `is_valid_sale = true` entram nos indicadores. A data de referência do período é `stg_orders.order_date`, com limites inicial e final inclusivos.

## Fórmulas

O campo `discount` recebido em `itens[]` pelo Bling é tratado como percentual atribuível ao item:

```text
item_revenue = round_currency(quantity * unit_value * (1 - discount / 100))
items_quantity = sum(quantity dos itens de vendas válidas)
revenue = sum(item_revenue dos itens de vendas válidas)
average_ticket = revenue / valid_orders
```

Cada faturamento de item é arredondado para duas casas antes da soma. O ticket médio também é arredondado para duas casas. Quando não há pedidos válidos, o ticket médio é zero.

O frete e as demais despesas do pedido não entram no faturamento do item. O desconto geral do pedido também não é distribuído sem uma regra de atribuição explícita; somente o desconto informado no próprio item é aplicado.

## Devoluções e estornos

Quantidades negativas são preservadas. Quando a origem identificar uma devolução ou um estorno dessa forma, quantidade e faturamento diminuem na mesma proporção. Valor unitário negativo e desconto fora do intervalo de 0% a 100% são rejeitados.

## Persistência e segurança

O `PRATransformService` calcula `stg_order_items.item_revenue` durante a construção do staging. A coluna faz parte da mesma operação protegida que grava `stg_orders`, `stg_order_items` e `data_quality_errors`; uma falha restaura a última fotografia confirmada.

Entradas incompatíveis deixam `item_revenue` vazio e geram `invalid_item_revenue_inputs` em `data_quality_errors`, sem registrar SKU, preço, desconto ou outro valor comercial nos logs. Enquanto houver qualquer erro desse tipo, o pipeline retorna `item_revenue_quality_blocked` e não libera a classificação para consumo analítico.

O `PRAKpiService.calculateMetrics()` é uma função pura e sem acesso à planilha. Ela será reutilizada pela construção incremental de `mart_kpis` em PRA-30 / PRA-63.

## Encadeamento operacional

`PRAOrdersAnalyticsPipeline` executa, nesta ordem:

1. normalização técnica e cálculo do faturamento por item;
2. classificação de venda válida pela situação Atendido.

O mesmo orquestrador é usado por `runOrdersNormalization()` e pelo estágio final de `runDailySync()`, evitando que o job diário deixe `is_valid_sale` sem atualização.

Os retornos e logs operacionais contêm somente contagens, estados e identificadores de execução. Os valores calculados permanecem nas camadas de dados destinadas à análise.
