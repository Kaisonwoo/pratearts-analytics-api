# Renovação automática e atômica dos tokens do Bling

Guia técnico da US-006 (PRA-12) e da TT-006 (PRA-46).

## Quando a renovação acontece

`PRABlingClient.getAccessToken()` solicita um token com pelo menos 60 segundos de
validade restante. A verificação e a eventual renovação ocorrem dentro de um
`ScriptLock`, portanto execuções concorrentes relêem o estado depois de obter o
lock e somente a primeira chamada renova o token.

Para uma verificação manual segura no editor do Apps Script, execute
`refreshBlingAccessToken()`. O retorno informa apenas se houve renovação e o
estado de validade; nenhum token é retornado.

## Requisição ao Bling

- Método: `POST`.
- Endpoint: `https://bling.com.br/Api/v3/oauth/token`.
- Autenticação do aplicativo: HTTP Basic no servidor.
- Corpo: `grant_type=refresh_token` e o refresh token vigente.
- Header: `enable-jwt: 1`, mantido para continuar recebendo JWT.

## Garantias de consistência

1. A aplicação obtém o `ScriptLock` antes de decidir renovar.
2. O estado é relido dentro do lock.
3. Se outro processo já renovou o token, a segunda chamada encerra sem novo POST.
4. A resposta inteira é validada antes de qualquer gravação.
5. Access token, refresh token e expiração são atualizados juntos por uma única
   chamada a `setProperties`.
6. Quando o Bling retorna um novo refresh token, ele substitui o anterior.
7. Quando uma resposta válida omite o refresh token, o valor anterior é mantido.
8. Erros HTTP, JSON inválido ou payload incompleto não alteram o estado existente.

## Logs e respostas

Os eventos registram somente o resultado, o código HTTP, um código OAuth seguro
e a expiração. Credenciais, access token, refresh token e corpos de erro não são
registrados. Em falha, a API interna devolve uma mensagem genérica informando que
o último estado consistente foi preservado.

## Referências oficiais

- [Aplicativos e refresh token](https://developer.bling.com.br/aplicativos)
- [Migração e renovação com JWT](https://developer.bling.com.br/migracao-jwt)
