# Pratearts Analytics API

Integração analítica para transformar dados operacionais do Bling em relatórios e dashboards administrativos da Pratearts.

## Estado atual

O Sprint 0 — Fundação foi concluído. O projeto está no Sprint 1 — Acesso ao Bling, iniciando o fluxo OAuth 2.0 com `state` de uso único, callback seguro e persistência protegida dos tokens.

## Decisões do MVP

- Fonte operacional: Bling API v3.
- Plataforma de vendas: Nuvemshop.
- Carga histórica inicial: últimos 12 meses.
- Venda válida: pedido em situação Atendido.
- Data de referência: data do pedido.
- Devoluções e estornos: reduzem quantidade e faturamento quando identificáveis.
- Atualização diária planejada: 06:00 em `America/Sao_Paulo`.
- Público do dashboard: Administração.

## Arquitetura

1. O Apps Script consulta a API do Bling somente para leitura.
2. Dados brutos são persistidos sem sobrescrever a origem.
3. Uma camada de tratamento normaliza pedidos, itens, produtos, variações e fornecedores.
4. Indicadores são expostos para o dashboard e para a API de relatórios.
5. Logs registram execução, volume, duração e falhas sem incluir segredos.

Mais detalhes estão em [`docs/architecture.md`](docs/architecture.md).

## Estrutura do repositório

```text
src/
  api/          Entradas do web app
  clients/      Clientes de serviços externos
  config/       Leitura de configurações seguras
  core/         Erros e logging compartilhados
  jobs/         Rotinas agendadas
  services/     Regras de aplicação
  appsscript.json
tests/          Testes locais de estrutura e segurança
scripts/        Validações executadas antes de publicar
config/         Exemplos sem valores reais
docs/           Arquitetura, contratos, payloads sintéticos, ADRs e instruções
```

O contrato dos endpoints, campos e relacionamentos do Bling está documentado em [`docs/bling-api-mapping.md`](docs/bling-api-mapping.md). A matriz consumível por código está em [`config/bling-read-model.json`](config/bling-read-model.json).

## Pré-requisitos

- Node.js 22 ou superior.
- Conta Google com acesso ao projeto Apps Script.
- Apps Script API habilitada na conta Google.
- Aplicativo cadastrado na API v3 do Bling.

## Preparação local

```bash
npm install
npm run check
npm run clasp:login
```

Copie `.clasp.json.example` para `.clasp.json` e substitua apenas o `scriptId`. O arquivo real é ignorado pelo Git.

No PowerShell:

```powershell
Copy-Item .clasp.json.example .clasp.json
```

Depois de configurar o projeto remoto:

```bash
npm run clasp:status
npm run clasp:push
npm run clasp:open
```

## Configuração segura

Os valores reais devem ser cadastrados em **Configurações do projeto → Propriedades do script** no Apps Script. Consulte [`docs/configuration.md`](docs/configuration.md).

Para implantar o callback e realizar a primeira autorização, consulte [`docs/oauth-authorization.md`](docs/oauth-authorization.md).

Nunca envie ao GitHub:

- `client_secret`;
- access token;
- refresh token;
- `.clasp.json` real;
- IDs ou payloads comerciais não anonimizados.

## Qualidade

```bash
npm run check
```

Esse comando valida a estrutura, o manifesto e padrões comuns de vazamento de segredos, e depois executa os testes locais.

## Rastreabilidade

- Projeto Jira: [PRA — Pratearts Analytics API](https://kaisonwooo.atlassian.net/browse/PRA)
- Estrutura inicial: PRA-10 / US-002 e PRA-43 / TT-002
- Configuração segura: PRA-8 / US-003 e PRA-48 / TT-003
- Contratos da API do Bling: PRA-9 / US-004 e PRA-44 / TT-004
- Autorização OAuth do Bling: PRA-11 / US-005 e PRA-47 / TT-005

## Referências oficiais

- [Apps Script manifest](https://developers.google.com/apps-script/manifest)
- [google/clasp](https://github.com/google/clasp)
- [Bling API v3](https://developer.bling.com.br/bling-api)
- [Referência OpenAPI do Bling](https://developer.bling.com.br/referencia)
- [Boas práticas da API do Bling](https://developer.bling.com.br/boas-praticas)
- [Migração do Bling para JWT](https://developer.bling.com.br/migracao-jwt)
