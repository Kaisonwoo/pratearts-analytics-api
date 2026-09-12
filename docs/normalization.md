# Normalização de pedidos e itens

A implementação de PRA-23 / US-017 e PRA-58 / TT-017 cria a primeira transformação da camada `raw` para `staging`.

## Entrada e saída

O `PRATransformService` lê integralmente:

- `raw_orders`
- `raw_order_items`

E reconstrói de forma determinística:

- `stg_orders`
- `stg_order_items`

Cada execução recebe um `run_id` próprio e grava `processed_at`. As linhas de staging são ordenadas pelas chaves estáveis para facilitar auditoria e comparação entre execuções.

As três abas de destino são tratadas como um único lote lógico. Os novos dados
são gravados antes da remoção de linhas antigas; se qualquer aba falhar, as abas
já alteradas são restauradas a partir do snapshot anterior.

## Normalização

A transformação aplica as seguintes convenções:

- IDs técnicos válidos são strings numéricas positivas.
- Datas de pedido são normalizadas para `YYYY-MM-DD`.
- Timestamps de origem são normalizados para ISO 8601.
- Valores e quantidades válidos são números; ausências numéricas são tratadas como `0` e podem gerar aviso quando o campo é necessário para análise.
- Textos como número do pedido e SKU são convertidos para string e têm espaços externos removidos.
- `order_id` e `item_key` continuam sendo as chaves estáveis definidas na camada raw.

Registros sem uma chave obrigatória não entram no staging. Campos auxiliares inválidos não derrubam a execução: o valor é neutralizado e uma exceção de qualidade é registrada.

## Erros de qualidade

Problemas encontrados são registrados em `data_quality_errors` com chave determinística no formato:

`normalization:<tipo>:<chave>:<codigo>`

Exemplos de códigos:

- `missing_order_id`
- `invalid_order_date`
- `missing_status_id`
- `missing_item_key`
- `missing_product_id`
- `missing_sku`
- `orphan_order`
- `invalid_quantity`

Executar a transformação novamente não duplica a mesma exceção. Se uma inconsistência deixa de existir, o registro anterior recebe `resolved_at`. Erros de qualidade produzidos por outros componentes são preservados.

## Limites desta história

A US-017 trata somente consistência técnica e reprodutibilidade dos registros. Duas colunas já reservadas no esquema permanecem sem valor nesta etapa:

- `stg_orders.is_valid_sale`: será calculada na US-018 com a regra da situação Atendido.
- `stg_order_items.item_revenue`: será calculada na US-021 com a definição oficial de faturamento por item.

Dessa forma, a normalização não incorpora regras comerciais antes de elas serem implementadas e testadas nas histórias correspondentes.

## Execução

Após a coleta dos detalhes, execute `runOrdersNormalization()` para reconstruir o staging a partir do estado raw mais recente.

Antes de iniciar a gravação, a rotina verifica o orçamento compartilhado de
execução. Se a margem segura tiver sido atingida, retorna
`orders_normalization_budget_reached` sem alterar o staging confirmado.

O retorno contém somente contagens e metadados operacionais seguros; nenhum SKU, valor comercial ou payload é enviado aos logs.
