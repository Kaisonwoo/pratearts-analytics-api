# Observabilidade operacional

Esta implementação atende PRA-31 / US-031 e TT-031.

## Registro de execuções

`runDailySync()` cria um identificador técnico próprio e persiste o ciclo de
vida na aba `sync_runs`:

- início e término em UTC;
- status final e duração;
- páginas e registros processados;
- código estável de erro;
- `correlation_id` seguro para cruzar planilha e logs do Apps Script.

O registro não inclui URLs completas, payloads comerciais, credenciais ou
tokens. Falhas no próprio registro não interrompem a sincronização principal:
elas geram um evento seguro no log da plataforma.

## Alertas críticos

Resultados bloqueados e exceções inesperadas tentam notificar um espaço do
Google Chat por webhook. Configure `ALERT_GOOGLE_CHAT_WEBHOOK_URL` somente em
Script Properties. A propriedade é opcional e sensível.

Se o webhook não estiver configurado, a rotina:

1. mantém a falha em `sync_runs`;
2. registra `critical_alert_not_configured`;
3. não transforma a ausência do canal em uma segunda falha.

O alerta contém apenas job, código estável, `correlationId` e horário. O valor
do webhook nunca é escrito em logs ou respostas.

## Validação após implantação

1. Execute `provisionDataLayers()` e confirme o esquema existente.
2. Cadastre um webhook de teste em Script Properties.
3. Execute uma falha sintética controlada em ambiente de homologação.
4. Confirme uma linha finalizada em `sync_runs`.
5. Confirme a mensagem no Google Chat com o mesmo `correlationId`.
6. Remova a condição de falha e execute `runDailySync()` novamente.
