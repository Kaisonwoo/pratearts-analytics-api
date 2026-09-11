# Camadas de dados

Esta estrutura implementa a US-014/PRA-19 e a TT-014/PRA-57.

## Objetivo

Separar dados de origem, dados tratados, indicadores e controles operacionais para permitir auditoria, reprocessamento e evolução das regras sem misturar responsabilidades.

## Convenções

- `raw_*`: preserva campos de origem suficientes para reconstrução e auditoria.
- `stg_*`: recebe registros normalizados e regras de preparação; não é fonte direta do Bling.
- `mart_*`: contém agregações analíticas prontas para os relatórios.
- `sync_runs`, `data_quality_errors` e `order_detail_errors`: controles operacionais sem credenciais e sem payload comercial desnecessário.
- `_schema_registry`: catálogo técnico com aba, camada, chave, quantidade de colunas e versão do esquema.

## Esquemas provisionados

| Camada | Aba | Chave |
| --- | --- | --- |
| raw | `raw_orders` | `order_id` |
| raw | `raw_order_items` | `item_key` |
| raw | `raw_products` | `product_id` |
| raw | `raw_product_suppliers` | `link_id` |
| staging | `stg_orders` | `order_id` |
| staging | `stg_order_items` | `item_key` |
| staging | `stg_products` | `product_id` |
| staging | `stg_product_suppliers` | `product_id` |
| mart | `mart_kpis` | `period_key` |
| mart | `mart_product_sales` | `mart_key` |
| logs | `sync_runs` | `run_id` |
| logs | `data_quality_errors` | `error_key` |
| logs | `order_detail_errors` | `order_id` |

## Provisionamento

Execute `provisionDataLayers()` uma vez após configurar `DATA_SPREADSHEET_ID`. A rotina pode ser executada novamente: abas compatíveis são apenas validadas, abas ausentes são criadas e o registro de esquema é reconstruído.

Se uma aba já existente tiver cabeçalho incompatível, a rotina falha sem substituir os dados. Isso evita que uma mudança de versão altere silenciosamente dados já persistidos.

## Limites desta história

Esta história cria os contratos e a infraestrutura das quatro camadas. Transformações, regra de venda válida, atribuição analítica, KPIs e construção incremental dos marts pertencem às histórias posteriores.
