# ADR-001 — Decisões de fundação do MVP

## Status

Aprovado.

## Contexto

A Pratearts precisa consolidar relatórios do Bling com atualização diária e acesso administrativo. O primeiro MVP será desenvolvido em Google Apps Script e Google Sheets.

## Decisões

- Carregar inicialmente os últimos 12 meses.
- Usar a data do pedido como referência temporal da venda.
- Contabilizar somente pedidos em situação Atendido.
- Abater devoluções e estornos quando identificáveis.
- Usar o fornecedor principal ou preferencial do produto.
- Executar diariamente às 06:00 em `America/Sao_Paulo`.
- Manter a propriedade inicial na conta Google pessoal do responsável.
- Preparar transferência futura para uma conta empresarial.
- Armazenar segredos exclusivamente em Script Properties.

## Consequências

A carga inicial reduz o risco de exceder cotas do Apps Script. Será necessária uma reconciliação periódica para alterações tardias. A dependência da conta pessoal deve ser tratada antes da operação definitiva.
