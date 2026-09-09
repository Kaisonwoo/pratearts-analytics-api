# Configuração por Script Properties

## Propriedades

| Propriedade | Obrigatória | Sensível | Finalidade |
|---|---:|---:|---|
| `BLING_CLIENT_ID` | Sim | Sim | Identifica o aplicativo no OAuth do Bling. |
| `BLING_CLIENT_SECRET` | Sim | Sim | Autentica o aplicativo no servidor de autorização. |
| `BLING_ACCESS_TOKEN` | Após OAuth | Sim | Autoriza chamadas à API. |
| `BLING_REFRESH_TOKEN` | Após OAuth | Sim | Renova o acesso sem nova autorização manual. |
| `BLING_TOKEN_EXPIRES_AT` | Após OAuth | Não | Instante de expiração calculado. |
| `BLING_STATUS_ATENDIDO_ID` | Antes da coleta | Não | ID técnico da situação válida de venda. |
| `DATA_SPREADSHEET_ID` | Antes da persistência | Não | Identifica a base de dados do MVP. |
| `SYNC_TIMEZONE` | Não | Não | Padrão: `America/Sao_Paulo`. |
| `SYNC_HOUR` | Não | Não | Padrão: `6`. |

## Cadastro

1. Abra o projeto no Apps Script.
2. Acesse **Configurações do projeto**.
3. Em **Propriedades do script**, adicione cada chave necessária.
4. Não copie valores reais para arquivos locais ou documentação.
5. Execute `healthCheck` e confirme somente a presença das configurações.

O health check nunca retorna o conteúdo dos segredos.
