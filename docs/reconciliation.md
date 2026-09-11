# Reconciliação histórica móvel

A implementação de PRA-22 / US-016 e PRA-55 / TT-016 relê uma janela recente de pedidos para capturar cancelamentos, mudanças de situação, correções e atendimentos tardios que podem ocorrer depois da sincronização incremental original.

## Janela e frequência

A rotina usa duas Script Properties públicas:

- `BLING_RECONCILIATION_WINDOW_DAYS`: tamanho da janela histórica inclusiva. Padrão `30`, faixa permitida de `1` a `365` dias.
- `BLING_RECONCILIATION_FREQUENCY_DAYS`: intervalo mínimo entre reconciliações concluídas. Padrão `7`, faixa permitida de `1` a `90` dias.

A consulta usa `GET /pedidos/vendas` com `dataInicial`, `dataFinal`, `pagina` e `limite`, sem filtro de situação. Isso permite que pedidos que deixaram de estar em Atendido também sejam reencontrados e atualizados.

## Retomada segura

O checkpoint temporário fica em `BLING_RECONCILIATION_CHECKPOINT`. Ele contém somente metadados operacionais, como janela, fase, página e contadores.

A página só avança depois que os IDs foram aceitos pela fila de detalhes. Se houver falha na API ou no enfileiramento, a próxima execução repete a mesma página.

Quando a última página é encontrada, a rotina muda para a fase `mark`. Essa fase registra a janela em `recalc_windows`. Se a marcação falhar, a próxima execução repete apenas a marcação, sem consultar novamente as páginas do Bling.

O resumo da última reconciliação concluída fica em `BLING_LAST_RECONCILIATION_RUN`.

## Substituição do estado anterior

Os pedidos encontrados são enviados novamente para `PRAOrderDetailsQueue`. Pedidos já processados em execuções anteriores podem ser reenfileirados porque a deduplicação considera apenas IDs ainda pendentes.

Quando `runOrderDetailsBatch()` processa esses IDs, `PRAOrderDetailsStore.persistBatch()` substitui o pedido pela chave `order_id` e substitui os itens dos pedidos afetados. Assim, cancelamentos e demais mudanças passam a representar o estado mais recente sem criar duplicidades.

## Marcação para recálculo

A aba `recalc_windows` pertence à camada de logs/controle e contém:

- `recalc_key`
- `window_start`
- `window_end`
- `reason`
- `status`
- `marked_at`
- `run_id`

A chave é determinística por janela e motivo. Repetir a mesma reconciliação atualiza o mesmo marcador `pending`, em vez de gerar registros duplicados.

A Sprint 3 poderá consumir esses marcadores para recalcular somente os indicadores afetados.

## Execução manual

`runOrdersReconciliation(force, reset)` executa a rotina.

- `force=true`: ignora a frequência mínima, sem ignorar os demais controles.
- `reset=true`: descarta somente o checkpoint incompleto e inicia uma nova janela.

Um checkpoint já incompleto sempre é retomado, mesmo que a frequência mínima ainda não tenha sido atingida.
