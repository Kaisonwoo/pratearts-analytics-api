# Arquitetura preliminar

## Objetivo

Separar integração, armazenamento, tratamento e apresentação para permitir que o MVP evolua sem misturar credenciais, regras de negócio e acesso a dados.

## Componentes

### Bling API v3

Fonte de pedidos, itens, produtos, variações, fornecedores e estoque. O acesso será somente leitura e usará OAuth 2.0 com tokens JWT quando disponibilizados pelo fluxo do Bling.

### Google Apps Script

Executa autenticação, chamadas HTTP, paginação, retentativas, normalização, sincronização em lotes e endpoints administrativos.

### Google Sheets

Armazenamento inicial do MVP, separado em três camadas:

- `raw`: resposta preservada da origem e metadados da coleta;
- `staging`: dados normalizados e relacionamentos;
- `analytics`: indicadores prontos para consumo.

### Dashboard

Visualização exclusiva para a Administração. A tecnologia definitiva será validada entre Looker Studio e interface web do Apps Script.

## Fluxo

1. Um gatilho diário inicia uma execução identificada por ID.
2. A configuração é lida de Script Properties.
3. O cliente Bling valida ou renova o token.
4. Coletores consultam páginas respeitando os limites da API.
5. Dados brutos são gravados antes do tratamento.
6. Serviços normalizam entidades e calculam indicadores.
7. O estado do lote permite retomada após falha.
8. Logs registram somente metadados não sensíveis.

Para a carga inicial de pedidos, `PRAOrdersInitialLoad` consulta somente vendas
na situação `Atendido`, processa páginas em lotes limitados e confirma o
checkpoint apenas após cada página ser aceita pelo armazenamento. O último
checkpoint válido permite retomar a partir da página seguinte sem duplicar a
confirmação do lote anterior.

As páginas confirmadas alimentam `PRAOrderDetailsQueue` somente com IDs
técnicos. `PRAOrderDetailsJob` consulta os detalhes em lotes e confirma a saída
da fila após `PRAOrderDetailsStore` substituir o pedido e seus itens pela chave
estável. Falhas temporárias permanecem na fila; falhas permanentes ficam
registradas sem payloads ou dados pessoais.

## Princípios

- Segurança por padrão.
- Operações idempotentes.
- Retomada de lotes interrompidos.
- Rastreabilidade entre código, Jira e documentação.
- IDs e SKUs como chaves técnicas.
- Nenhum segredo em código, planilha ou log.
