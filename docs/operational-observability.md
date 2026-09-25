# Observabilidade operacional

Esta implementação atende PRA-41 / US-031 e PRA-72 / TT-031. A história
PRA-31 corresponde a US-025 (resumo de KPIs).

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

## Estado da homologação

Em 25/09/2026, a execução diária iniciada às 06:01:51 (São Paulo) e quatro
continuações baseadas no tempo terminaram sem erro. Após a rotação protegida e a
reautorização das credenciais Bling, o teste da API de produtos retornou HTTP
200 e uma nova execução manual de `runDailySync()` terminou com
`daily_sync_completed`, `pending: 0` e sem continuação. A aba `sync_runs`
registrou `5e99c836-6a6e-46a0-9ee4-30092837feeb` com `status: completed`,
`duration_ms: 50663`, `pages_processed: 1`, `records_processed: 14` e
`error_code` vazio. O ciclo processou 474 pedidos e 909 itens, sem que essas
contagens representem crescimento líquido da base.

PRA-41 e PRA-72 estão em Fazendo no Jira. A conta Google pessoal usada na
implantação não fornece o webhook do Google Chat; a propriedade
`ALERT_GOOGLE_CHAT_WEBHOOK_URL` não está configurada. A entrega de um alerta
crítico controlado e a primeira renovação automática do token após a rotação
ainda não foram comprovadas. Nenhum valor de credencial foi registrado aqui.

## Validação após implantação

1. Execute `provisionDataLayers()` e confirme o esquema existente.
2. Cadastre um webhook de teste em Script Properties.
3. Execute uma falha sintética controlada em ambiente de homologação.
4. Confirme uma linha finalizada em `sync_runs`.
5. Confirme a mensagem no Google Chat com o mesmo `correlationId`.
6. Remova a condição de falha e execute `runDailySync()` novamente.
