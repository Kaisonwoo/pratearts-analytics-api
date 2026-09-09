# Autorização OAuth 2.0 do Bling

Guia operacional da US PRA-11 e da tarefa PRA-47. O fluxo implementado é o Authorization Code, com callback no web app do Google Apps Script e emissão de tokens JWT.

## Fluxo

1. O administrador acessa o web app com `?action=authorize` ou executa `getBlingAuthorizationUrl` no editor.
2. A aplicação cria um `state` aleatório, armazena somente seu hash e define validade de 10 minutos.
3. O administrador abre o link temporário e autoriza o aplicativo no Bling.
4. O Bling redireciona o navegador para `BLING_REDIRECT_URI` com `code` e `state`.
5. A aplicação consome o `state` uma única vez e rejeita valores ausentes, expirados, divergentes ou reutilizados.
6. O código é trocado no servidor por access e refresh tokens.
7. Os tokens são gravados em Script Properties e a tela retorna apenas o resultado seguro.

## Endpoints oficiais

- Autorização: `GET https://bling.com.br/Api/v3/oauth/authorize`
- Token: `POST https://bling.com.br/Api/v3/oauth/token`
- Tipo de concessão inicial: `authorization_code`
- Autenticação do cliente: HTTP Basic no servidor
- Emissão JWT: header `enable-jwt: 1`

Os valores de `client_id`, `client_secret`, `code`, `state`, access token e refresh token nunca são registrados em logs.

## Implantação do callback

1. No Apps Script, selecione **Implantar → Nova implantação → App da Web**.
2. Configure a execução como o proprietário do projeto.
3. Restrinja o acesso à conta administrativa usada na autorização.
4. Copie a URL HTTPS terminada em `/exec`.
5. Cadastre exatamente essa URL como callback do aplicativo no Bling.
6. Salve a mesma URL na Script Property `BLING_REDIRECT_URI`.
7. Cadastre `BLING_CLIENT_ID` e `BLING_CLIENT_SECRET` somente em Script Properties.
8. Publique o código com `clasp push` e crie uma nova versão da implantação quando necessário.

O callback deve ser a URL base do web app, sem `?action=authorize`.

## Primeira autorização

Opção pelo navegador:

```text
https://script.google.com/macros/s/SEU_DEPLOYMENT_ID/exec?action=authorize
```

Opção pelo editor:

1. Execute `getBlingAuthorizationUrl`.
2. Copie somente a `authorizationUrl` retornada.
3. Abra a URL no navegador em até 10 minutos.

Após autorizar, execute `healthCheck`. O resultado esperado é:

- `blingConfigured: true`;
- `blingAuthenticated: true`;
- `accessTokenPresent: true`;
- `refreshTokenPresent: true`;
- `expired: false`.

O diagnóstico nunca mostra os valores dos tokens.

## Falhas tratadas

| Situação | Resposta segura | Ação |
|---|---|---|
| Configuração incompleta | Solicita revisão das Script Properties | Conferir as três propriedades do OAuth |
| Autorização recusada | Informa que nenhum token novo foi armazenado | Gerar outro link quando desejar continuar |
| `state` ausente ou divergente | Rejeita o callback | Gerar outro link; não reutilizar o anterior |
| Link expirado ou reutilizado | Rejeita o callback | Gerar outro link dentro da validade |
| Código ausente | Informa que o código não foi recebido | Reiniciar a autorização |
| Troca de token recusada | Mostra mensagem genérica sem corpo da resposta | Gerar outro link e revisar o aplicativo no Bling |

## Segurança validada

- Somente o hash SHA-256 do `state` é persistido.
- Cada link possui validade de 10 minutos e uso único.
- A leitura e remoção do `state` usam `ScriptLock`.
- O código de autorização e o Client Secret são enviados apenas ao endpoint de token.
- `muteHttpExceptions` permite tratamento controlado sem devolver o payload do Bling ao navegador.
- O callback retorna apenas código, mensagem e indicadores de presença/expiração.

## Referências

- [Autenticação da API do Bling](https://developer.bling.com.br/bling-api)
- [Referência OpenAPI do Bling](https://developer.bling.com.br/referencia)
- [Migração para JWT](https://developer.bling.com.br/migracao-jwt)
