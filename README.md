# Pratearts Analytics API

Integração analítica para transformar dados operacionais do Bling em relatórios e dashboards administrativos da Pratearts.

## Estado atual

Os Sprints 0 e 1 foram concluídos. O projeto está no Sprint 2 — Coleta e persistência, com pedidos, detalhes e itens integrados e a reconciliação retomável de produtos em desenvolvimento.

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
  repositories/ Persistência idempotente no Google Sheets
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

Para entender a renovação sob lock, o comportamento em falhas e a validação manual, consulte [`docs/token-renewal.md`](docs/token-renewal.md).

Para usar o cliente HTTP autenticado, compreender os envelopes de resposta e executar o teste seguro de conectividade, consulte [`docs/http-client.md`](docs/http-client.md).

Para consultar listagens completas com paginação, ritmo controlado e backoff exponencial, consulte [`docs/pagination-resilience.md`](docs/pagination-resilience.md).

Para interpretar os estados de conectividade e o registro do último acesso bem-sucedido, consulte [`docs/connectivity-health.md`](docs/connectivity-health.md).

Para executar a carga inicial e a coleta retomável dos detalhes, consulte [`docs/orders-initial-load.md`](docs/orders-initial-load.md) e [`docs/order-details.md`](docs/order-details.md).

Para reconciliar produtos, SKUs e relações pai/filho, consulte [`docs/products-sync.md`](docs/products-sync.md).

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
- Renovação automática dos tokens: PRA-12 / US-006 e PRA-46 / TT-006
- Cliente HTTP autenticado: PRA-13 / US-007 e PRA-45 / TT-007
- Paginação, limites e retentativas: PRA-14 / US-008 e PRA-49 / TT-008
- Diagnóstico de conectividade: PRA-15 / US-009 e PRA-52 / TT-009
- Carga inicial de pedidos Atendidos: PRA-17 / US-010 e PRA-50 / TT-010
- Detalhes e itens dos pedidos: PRA-18 / US-011 e PRA-51 / TT-011
- Produtos e relações pai/filho: PRA-16 / US-012 e PRA-53 / TT-012

## Referências oficiais

- [Apps Script manifest](https://developers.google.com/apps-script/manifest)
- [google/clasp](https://github.com/google/clasp)
- [Bling API v3](https://developer.bling.com.br/bling-api)
- [Referência OpenAPI do Bling](https://developer.bling.com.br/referencia)
- [Boas práticas da API do Bling](https://developer.bling.com.br/boas-praticas)
- [Migração do Bling para JWT](https://developer.bling.com.br/migracao-jwt)
