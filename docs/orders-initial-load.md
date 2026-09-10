# Carga inicial de pedidos atendidos

Documento técnico da US-010/PRA-17 e da tarefa TT-010/PRA-50.

## Escopo

`PRAOrdersInitialLoad.run` consulta somente `GET /pedidos/vendas`, filtrando pelo
ID configurado da situação **Atendido** e por um intervalo explícito
`YYYY-MM-DD`. A função não grava payloads, tokens ou dados comerciais em
Script Properties; ela devolve apenas contagens e metadados da execução.

## Retomada segura

- Cada página é confirmada somente depois de ser recebida e aceita pelo
  callback de armazenamento, quando fornecido.
- O checkpoint contém período, situação, página seguinte, contagem de páginas,
  contagem de registros e `runId`.
- Falha HTTP ou de persistência preserva a página atual para a próxima execução.
- O orçamento de páginas por execução é configurável e limitado para evitar
  exceder o tempo de execução do Apps Script.
- Ao encontrar uma página menor que o limite, a carga é marcada como
  `completed`, o checkpoint ativo é removido e o resumo seguro é preservado.

## Configuração necessária

Configure `BLING_STATUS_ATENDIDO_ID` com o ID resolvido na conta do Bling.
O valor não é fixado pelo código nem inferido dos payloads sintéticos. O padrão
de `BLING_MAX_PAGES_PER_RUN` é 10, com limite máximo de 100 páginas por execução.

## Execução manual

No Apps Script, execute `runInitialOrdersLoad` informando `startDate` e
`endDate`. Para retomar, execute novamente com o mesmo período. O retorno
`in_progress` informa `nextPage`; `completed` informa o intervalo e as
contagens finais. `page_fetch_failed` e `page_persistence_failed` não avançam
o checkpoint.

## Segurança

Logs e retornos contêm apenas estado, período, contagens, página, status HTTP,
correlation ID e códigos de erro. Nenhum pedido, cliente, endereço, credencial
ou token é copiado para o repositório, Script Properties ou evidência de Jira.
