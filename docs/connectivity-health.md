# Diagnóstico de conectividade do Bling

Documento técnico da US PRA-15 e da tarefa PRA-52.

## Objetivo

O diagnóstico verifica a configuração, a validade local do token e uma chamada mínima de leitura ao Bling. A resposta contém somente metadados operacionais e diferencia três estados:

| Estado | Significado |
|---|---|
| `authorized` | O token está válido e a consulta mínima ao Bling respondeu com sucesso. |
| `expired` | O token está expirado, próximo da expiração ou foi recusado com HTTP 401. |
| `unavailable` | A configuração/autorização está ausente ou o Bling não respondeu com sucesso. |

## Resposta segura

`PRAHealthService.checkBlingConnectivity()` retorna:

- `state` e `code` públicos;
- código HTTP, quando houve resposta;
- horário ISO da verificação;
- `correlationId` da tentativa;
- horário e `correlationId` do último acesso bem-sucedido.

Tokens, credenciais, parâmetros, payloads e dados de produtos não aparecem no retorno nem são registrados como evidência.

## Último acesso bem-sucedido

Somente verificações autorizadas atualizam `BLING_LAST_SUCCESS_AT` e `BLING_LAST_SUCCESS_CORRELATION_ID`. As duas propriedades são internas, gravadas juntas sob `ScriptLock` e omitidas da configuração pública.

Uma falha posterior preserva o último sucesso conhecido para que o administrador saiba quando a integração conseguiu acessar o Bling pela última vez.

## Como validar no Apps Script

1. Implante a versão atual do projeto.
2. Execute `testBlingApiConnection` no editor.
3. Confirme que o resultado contém `state`, `checkedAt`, `correlationId` e `lastSuccessfulAt`.
4. Não copie tokens ou dados comerciais para logs, Jira ou documentação.

O endpoint padrão do web app usa `PRAHealthService.getStatus()` e inclui o mesmo bloco em `connectivity`.

## Referências

- [PropertiesService do Google Apps Script](https://developers.google.com/apps-script/reference/properties/properties-service)
- [LockService do Google Apps Script](https://developers.google.com/apps-script/reference/lock/lock-service)
- [Referência da API do Bling](https://developer.bling.com.br/referencia)
