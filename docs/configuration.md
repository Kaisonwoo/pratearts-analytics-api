# Configuração segura por Script Properties

## Princípios

- Credenciais e tokens existem somente em **Script Properties**, no servidor do Apps Script.
- Nenhum segredo é aceito em arquivos, parâmetros de URL, respostas públicas ou logs.
- `PRAConfig` expõe apenas configurações não sensíveis e indicadores de presença.
- `PRASecrets` centraliza a leitura de credenciais e a gravação atômica dos tokens.
- Atualizações de tokens usam `LockService`; a necessidade de renovação é relida dentro do lock para impedir duas execuções simultâneas de consumirem o mesmo refresh token.
- Respostas de renovação são validadas por completo antes de access token, refresh token e expiração serem gravados juntos.

## Propriedades

| Propriedade | Obrigatória | Sensível | Finalidade |
|---|---:|---:|---|
| `BLING_CLIENT_ID` | Sim | Sim | Identifica o aplicativo no OAuth do Bling. |
| `BLING_CLIENT_SECRET` | Sim | Sim | Autentica o aplicativo no servidor de autorização. |
| `BLING_REDIRECT_URI` | Sim | Não | URL HTTPS cadastrada como redirecionamento do aplicativo. |
| `BLING_ACCESS_TOKEN` | Após OAuth | Sim | Autoriza chamadas à API. |
| `BLING_REFRESH_TOKEN` | Após OAuth | Sim | Renova o acesso sem nova autorização manual. |
| `BLING_TOKEN_EXPIRES_AT` | Após OAuth | Não | Expiração do access token em Unix epoch, milissegundos. |
| `BLING_OAUTH_STATE_HASH` | Gerenciada | Sim | Hash SHA-256 temporário usado para validar o callback. |
| `BLING_OAUTH_STATE_EXPIRES_AT` | Gerenciada | Não | Expiração do link de autorização, em Unix epoch. |
| `BLING_REQUESTS_PER_SECOND` | Não | Não | Ritmo máximo entre 1 e 3 chamadas por segundo; padrão: `3`. |
| `BLING_PAGE_SIZE` | Não | Não | Registros solicitados por página, entre 1 e 100; padrão: `100`. |
| `BLING_MAX_RETRIES` | Não | Não | Retentativas de falhas transitórias, entre 0 e 5; padrão: `3`. |
| `BLING_BACKOFF_BASE_MS` | Não | Não | Espera inicial do backoff; padrão: `1000` ms. |
| `BLING_BACKOFF_MAX_MS` | Não | Não | Teto da espera progressiva; padrão: `8000` ms. |
| `BLING_MAX_PAGES` | Não | Não | Limite de segurança por listagem; padrão: `1000`. |
| `BLING_MAX_PAGES_PER_RUN` | Não | Não | Limita páginas da carga inicial por execução; padrão: `10`. |
| `BLING_NEXT_REQUEST_AT` | Gerenciada | Não | Reserva interna do próximo intervalo permitido entre chamadas. |
| `BLING_LAST_SUCCESS_AT` | Gerenciada | Não | Horário ISO da última chamada mínima concluída com sucesso. |
| `BLING_LAST_SUCCESS_CORRELATION_ID` | Gerenciada | Não | Identificador seguro da última chamada mínima bem-sucedida. |
| `BLING_STATUS_ATENDIDO_ID` | Antes da coleta | Não | ID técnico da situação válida de venda. |
| `DATA_SPREADSHEET_ID` | Antes da persistência | Não | Identifica a base de dados do MVP. |
| `BLING_MAX_ORDER_DETAILS_PER_RUN` | Antes da coleta de detalhes | Não | Limita pedidos detalhados por execução; padrão 20, máximo 100. |
| `BLING_EXECUTION_BUDGET_MS` | Não | Não | Orçamento compartilhado por execução, de 60000 a 330000 ms; padrão: `270000`. |
| `BLING_ORDER_DETAILS_QUEUE_INDEX` | Gerenciada | Não | Índice interno da fila fragmentada; contém somente contagens e chaves técnicas. |
| `SYNC_TIMEZONE` | Não | Não | Padrão: `America/Sao_Paulo`. |
| `SYNC_HOUR` | Não | Não | Inteiro entre 0 e 23; padrão: `6`. |

O orçamento padrão encerra cada etapa com margem antes do limite do Apps Script.
Quando ainda há páginas ou pedidos pendentes, o checkpoint é preservado e um
único gatilho de continuação é programado. Esse fluxo usa o escopo
`script.scriptapp` declarado no manifesto.

Os jobs incremental, reconciliação, fornecedores e detalhes usam leases curtos
em Script Properties. Uma segunda execução do mesmo job retorna
`execution_in_progress`; o lease expira automaticamente caso uma execução seja
interrompida pelo limite da plataforma.

## Cadastro manual

1. Abra o projeto no Apps Script.
2. Acesse **Configurações do projeto**.
3. Em **Propriedades do script**, adicione as chaves necessárias.
4. Insira os valores reais somente nessa tela.
5. Nunca copie valores reais para arquivos locais, Jira, Google Docs, logs ou GitHub.
6. Execute `healthCheck` e confirme somente os indicadores de presença e validade.

## Regras do OAuth do Bling

- O fluxo adotado é **Authorization Code**.
- O `authorization_code` deve ser trocado por tokens no servidor e expira em 1 minuto.
- As credenciais do aplicativo são enviadas por HTTP Basic no endpoint de token, nunca no corpo.
- O header `enable-jwt: 1` será usado na obtenção, renovação e consumo dos tokens.
- O `state` deverá ser aleatório, validado e consumido uma única vez para proteção contra CSRF.
- Somente o hash do `state` é persistido e sua validade é de 10 minutos.
- O refresh token possui vida útil superior ao access token; a documentação atual informa 30 dias.

Referências oficiais:

- https://developer.bling.com.br/aplicativos
- https://developer.bling.com.br/migracao-jwt
- https://developer.bling.com.br/perguntas-frequentes

## Diagnóstico seguro

O health check diferencia três estados operacionais:

- `authorized`: token válido e consulta mínima ao Bling concluída;
- `expired`: token expirado, próximo da expiração ou recusado com HTTP 401;
- `unavailable`: configuração/autorização ausente ou serviço indisponível.

O retorno inclui horário, `correlationId` e o último acesso bem-sucedido, além dos indicadores públicos de configuração e presença dos tokens.

Ele nunca retorna Client ID, Client Secret, access token ou refresh token.

O contrato e a validação manual estão em [`connectivity-health.md`](connectivity-health.md).
O passo a passo completo de implantação e primeira autorização está em [`oauth-authorization.md`](oauth-authorization.md).
O fluxo de renovação automática e seu teste manual seguro estão em [`token-renewal.md`](token-renewal.md).
O paginador, o limitador de chamadas e as retentativas estão em [`pagination-resilience.md`](pagination-resilience.md).
A carga inicial e a fila de detalhes estão em [`orders-initial-load.md`](orders-initial-load.md) e [`order-details.md`](order-details.md).
