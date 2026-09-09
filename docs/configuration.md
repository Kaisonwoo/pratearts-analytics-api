# Configuração segura por Script Properties

## Princípios

- Credenciais e tokens existem somente em **Script Properties**, no servidor do Apps Script.
- Nenhum segredo é aceito em arquivos, parâmetros de URL, respostas públicas ou logs.
- `PRAConfig` expõe apenas configurações não sensíveis e indicadores de presença.
- `PRASecrets` centraliza a leitura de credenciais e a gravação atômica dos tokens.
- Atualizações de tokens usam `LockService` para impedir duas execuções simultâneas de sobrescreverem o estado.

## Propriedades

| Propriedade | Obrigatória | Sensível | Finalidade |
|---|---:|---:|---|
| `BLING_CLIENT_ID` | Sim | Sim | Identifica o aplicativo no OAuth do Bling. |
| `BLING_CLIENT_SECRET` | Sim | Sim | Autentica o aplicativo no servidor de autorização. |
| `BLING_REDIRECT_URI` | Sim | Não | URL HTTPS cadastrada como redirecionamento do aplicativo. |
| `BLING_ACCESS_TOKEN` | Após OAuth | Sim | Autoriza chamadas à API. |
| `BLING_REFRESH_TOKEN` | Após OAuth | Sim | Renova o acesso sem nova autorização manual. |
| `BLING_TOKEN_EXPIRES_AT` | Após OAuth | Não | Expiração do access token em Unix epoch, milissegundos. |
| `BLING_STATUS_ATENDIDO_ID` | Antes da coleta | Não | ID técnico da situação válida de venda. |
| `DATA_SPREADSHEET_ID` | Antes da persistência | Não | Identifica a base de dados do MVP. |
| `SYNC_TIMEZONE` | Não | Não | Padrão: `America/Sao_Paulo`. |
| `SYNC_HOUR` | Não | Não | Inteiro entre 0 e 23; padrão: `6`. |

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
- O refresh token possui vida útil superior ao access token; a documentação atual informa 30 dias.

Referências oficiais:

- https://developer.bling.com.br/aplicativos
- https://developer.bling.com.br/migracao-jwt
- https://developer.bling.com.br/perguntas-frequentes

## Diagnóstico seguro

O health check pode retornar:

- nomes de propriedades ausentes ou inválidas;
- presença de access token e refresh token;
- instante de expiração e indicador `expired`;
- estado geral `configured` e `authenticated`.

Ele nunca retorna Client ID, Client Secret, access token ou refresh token.
