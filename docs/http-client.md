# Cliente HTTP do Bling

Documento técnico da US PRA-13 e da tarefa PRA-45.

## Objetivo

`PRABlingClient` é a única porta de entrada para chamadas autenticadas à API v3 do Bling. Nesta entrega, o cliente oferece operações `GET`, porque o MVP é estritamente somente leitura.

Antes de cada chamada, o cliente obtém um access token válido pelo componente OAuth. Se o token estiver próximo do vencimento, a renovação atômica já implementada ocorre antes do acesso à API.

## Contrato de sucesso

Respostas HTTP `2xx` são desembrulhadas do envelope `data` documentado pelo Bling:

```javascript
{
  ok: true,
  statusCode: 200,
  correlationId: 'uuid-da-execucao',
  durationMs: 120,
  data: []
}
```

O campo `data` é destinado somente às camadas internas de coleta. Ele não é escrito nos logs pelo cliente.

## Contrato de falha

Erros HTTP, respostas inválidas e falhas de rede usam um envelope previsível:

```javascript
{
  ok: false,
  statusCode: 429,
  correlationId: 'uuid-da-execucao',
  durationMs: 90,
  error: {
    code: 'rate_limited',
    message: 'O limite temporário de chamadas do Bling foi atingido.',
    retryable: true
  }
}
```

O corpo de erros do Bling não é devolvido nem registrado, pois pode conter dados operacionais. Os códigos `408`, `429` e `5xx` são classificados como transitórios. A retentativa com backoff e o paginador serão implementados na PRA-14/PRA-49.

## Observabilidade e segurança

- Cada chamada recebe um `correlationId` UUID.
- Os logs incluem somente operação, código HTTP, duração, código de erro e possibilidade de retentativa.
- URL completa, parâmetros, payloads, cabeçalho `Authorization` e mensagens brutas não são registrados.
- O caminho precisa ser relativo e não pode apontar para outro host, reduzindo risco de SSRF.
- O cliente aceita somente `GET` nesta versão.

## Teste manual seguro

No editor do Apps Script, execute `testBlingApiConnection`. A função consulta somente a primeira posição da primeira página de produtos (`limite=1`) e devolve apenas:

- `ok` e código do resultado;
- status HTTP;
- `correlationId`;
- horário do teste;
- contagem de registros recebidos.

Nenhum produto, cliente, credencial ou token aparece no retorno. Uma execução bem-sucedida deve apresentar `ok: true`, `code: connected` e `statusCode: 200`.

## Referências

- [Boas práticas da API do Bling](https://developer.bling.com.br/boas-praticas)
- [Referência OpenAPI do Bling](https://developer.bling.com.br/referencia)
- [UrlFetchApp do Google Apps Script](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app)
