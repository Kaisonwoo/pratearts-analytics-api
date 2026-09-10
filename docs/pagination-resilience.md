# Paginação e resiliência do cliente Bling

Documento técnico da US PRA-14 e da tarefa PRA-49.

## Paginação determinística

Listagens usam `PRABlingClient.getAllPages(path, query, options)`. O método começa em `pagina=1`, solicita até 100 registros por chamada e incrementa a página exatamente uma vez após cada resposta bem-sucedida.

A coleta termina quando uma página retorna menos registros que o `limite`. Se o teto configurado de páginas for alcançado antes dessa condição, o resultado falha com `pagination_limit`; dados parciais não são tratados como carga completa.

Exemplo interno:

```javascript
var result = PRABlingClient.getAllPages('/produtos', {}, {
  operation: 'products.list',
  pageSize: 100
});
```

## Controle de ritmo

`PRAResilience.acquireRateLimitSlot()` serializa a reserva do próximo intervalo com `ScriptLock` e persiste somente um timestamp interno em Script Properties. Assim, execuções simultâneas compartilham o mesmo limite.

O padrão conservador do projeto é de 3 chamadas por segundo. A propriedade `BLING_REQUESTS_PER_SECOND` permite reduzir o ritmo para 1 ou 2, mas a validação impede valores acima de 3.

## Retentativas e backoff

Somente falhas transitórias são repetidas:

- HTTP `408`;
- HTTP `429`;
- HTTP `5xx`;
- falha de rede antes de uma resposta HTTP.

Erros permanentes, como `400`, `401`, `403`, `404`, `409` e `422`, retornam imediatamente. O padrão permite 3 retentativas, com esperas de 1, 2 e 4 segundos. A espera nunca ultrapassa `BLING_BACKOFF_MAX_MS`.

Todas as tentativas mantêm o mesmo `correlationId`. Os logs registram apenas operação, código HTTP, número da tentativa, espera e duração; URL completa, parâmetros, respostas, produtos e tokens não são registrados.

## Propriedades opcionais

| Propriedade | Padrão | Faixa aceita |
|---|---:|---:|
| `BLING_REQUESTS_PER_SECOND` | 3 | 1–3 |
| `BLING_PAGE_SIZE` | 100 | 1–100 |
| `BLING_MAX_RETRIES` | 3 | 0–5 |
| `BLING_BACKOFF_BASE_MS` | 1000 | 250–10000 |
| `BLING_BACKOFF_MAX_MS` | 8000 | valor base–30000 |
| `BLING_MAX_PAGES` | 1000 | 1–10000 |

As propriedades podem ser omitidas para usar os padrões. Nenhuma delas contém credenciais ou dados comerciais.

## Referências

- [Boas práticas da API do Bling](https://developer.bling.com.br/boas-praticas)
- [Referência OpenAPI do Bling](https://developer.bling.com.br/referencia)
- [LockService do Google Apps Script](https://developers.google.com/apps-script/reference/lock/lock-service)
