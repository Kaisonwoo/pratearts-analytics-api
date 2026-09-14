# Automação diária retomável — PRA-36 / PRA-71

Esta entrega implementa a US-030 e a TT-030. O objetivo é executar o pipeline
analítico diariamente sem depender de uma operação manual longa, preservando os
checkpoints e os limites do Google Apps Script.

## Contrato da agenda

- Handler recorrente: `runDailySync`.
- Horário: propriedade pública `SYNC_HOUR`, com padrão `6`.
- Fuso: propriedade pública `SYNC_TIMEZONE`, com padrão
  `America/Sao_Paulo`.
- Frequência: uma vez por dia, próximo do minuto zero da hora configurada.
- Continuações: `runDailySyncContinuation` permanece temporário e separado da
  agenda recorrente.

O Apps Script executa acionadores por relógio dentro de uma janela aproximada.
Por isso, 06:00 representa a hora operacional pretendida, não garantia de
execução no segundo exato.

## Entradas operacionais

| Função | Finalidade |
|---|---|
| `installDailySyncTrigger()` | Instala ou reconcilia a agenda configurada. |
| `getDailySyncTriggerStatus()` | Retorna horário, fuso, quantidade e aderência à configuração. |
| `removeDailySyncTrigger()` | Remove somente acionadores recorrentes de `runDailySync`. |
| `runDailySync()` | Executa incremental, reconciliação, detalhes, normalização e marts. |
| `runDailySyncContinuation()` | Retoma um pipeline interrompido com checkpoint seguro. |

Nenhuma dessas respostas inclui tokens, credenciais ou dados comerciais.

## Idempotência e substituição

O agendador mantém uma assinatura técnica não sensível em
`PRA_DAILY_TRIGGER_SIGNATURE`. Uma nova instalação:

1. valida `SYNC_HOUR`, `SYNC_TIMEZONE` e a configuração geral;
2. retorna sem alterações quando existe exatamente um acionador aderente;
3. cria o novo acionador antes de remover versões anteriores quando a
   configuração mudou;
4. preserva a agenda anterior se a criação do substituto falhar;
5. remove duplicatas do mesmo handler após a criação confirmada.

A operação usa `ScriptLock`. Outros handlers do projeto, inclusive os de
continuação, não são removidos.

## Concorrência e retomada

`PRADailySyncJob` adquire o lease `daily_sync` antes de iniciar a orquestração.
Uma segunda execução simultânea termina com
`daily_sync_execution_in_progress`, sem consultar o Bling ou gravar planilhas.
O lease é liberado no bloco `finally` e expira automaticamente caso a execução
seja interrompida pela plataforma.

Quando o orçamento seguro acaba, cada etapa mantém seu checkpoint e a
orquestração agenda no máximo um `runDailySyncContinuation`. A continuação usa
o mesmo lease do job diário e substitui somente o próprio acionador temporário.

## Implantação e homologação

1. executar `npm run check`;
2. gerar o runtime rastreável com `npm run build:runtime -- <destino>`;
3. substituir integralmente `Runtime.gs`, preservando manifesto e propriedades;
4. executar `getDailySyncTriggerStatus()` e registrar o estado anterior;
5. executar `installDailySyncTrigger()` uma vez;
6. executar novamente e confirmar `created: false`, `installed: 1` e
   `configured: true`;
7. confirmar no dashboard um único handler `runDailySync`;
8. acompanhar a primeira execução e qualquer continuação até o status final.

## Rollback

Execute `removeDailySyncTrigger()`. O retorno deve indicar quantos acionadores
recorrentes foram removidos. Checkpoints, dados persistidos, propriedades de
OAuth e acionadores temporários de continuação não são apagados.
