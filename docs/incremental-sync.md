# Sincronização incremental de pedidos

A implementação de PRA-21 / US-015 e PRA-56 / TT-015 adiciona a leitura diária de pedidos novos ou alterados no Bling.

## Estratégia

A consulta usa `GET /pedidos/vendas` com `dataAlteracaoInicial` e `dataAlteracaoFinal`. A rotina não filtra a situação do pedido, porque alterações como cancelamento, atendimento tardio ou mudança posterior de situação também precisam ser capturadas.

O primeiro intervalo incremental usa como baseline a última carga inicial concluída. Depois disso, o baseline passa a ser o `windowEnd` da última sincronização incremental confirmada.

## Margem de segurança

A Script Property `BLING_INCREMENTAL_LOOKBACK_DAYS` define quantos dias serão relidos antes do baseline confirmado.

- padrão: `1`
- mínimo: `0`
- máximo: `30`

Como os filtros são inclusivos por data, a margem pode reler pedidos já vistos. Isso é intencional: a fila de detalhes deduplica IDs pendentes e a persistência dos detalhes é idempotente por chave.

## Checkpoint

O checkpoint temporário fica em `BLING_INCREMENTAL_ORDERS_CHECKPOINT` e armazena somente metadados operacionais: identificador da execução, origem e data do baseline, janela, margem, próxima página, contadores e timestamps.

O checkpoint só avança depois que a página é confirmada pelo callback de persistência. Se a API ou a gravação falhar, a mesma página é repetida na execução seguinte.

Ao concluir a última página, o checkpoint temporário é removido e um resumo seguro é salvo em `BLING_LAST_INCREMENTAL_ORDERS_RUN`.

## Entradas

- `runDailySync()` executa a rotina incremental usando a fila padrão de detalhes.
- `runIncrementalOrdersSync(reset)` permite execução manual e reinício explícito do checkpoint.

## Limites desta história

Esta etapa implementa seleção incremental e checkpoint. Trigger automático, continuação agendada, processamento integral dos lotes e reconciliação histórica móvel pertencem às histórias posteriores.
