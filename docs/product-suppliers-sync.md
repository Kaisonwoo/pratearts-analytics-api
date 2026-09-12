# Sincronização de vínculos produto-fornecedor

Esta etapa implementa a US-013 / PRA-20 e a TT-013 / PRA-54. O objetivo é reconciliar os vínculos cadastrados no Bling entre produtos e fornecedores sem expor dados comerciais nos logs ou nos resumos operacionais.

## Origem

A coleta usa somente leitura no endpoint paginado:

```text
GET /produtos/fornecedores
```

Os campos preservados na camada bruta são os IDs técnicos do vínculo, produto e fornecedor, além dos campos do próprio vínculo necessários para análise e escolha do fornecedor principal.

## Persistência

A aba `raw_product_suppliers` armazena uma linha por vínculo do Bling:

- `link_id`
- `product_id`
- `supplier_id`
- `description`
- `supplier_sku`
- `cost_price`
- `purchase_price`
- `is_default`
- `updated_at`
- `run_id`

A persistência durante a coleta é idempotente por `link_id`. A reconciliação final mantém apenas os vínculos pertencentes à execução completa mais recente, removendo vínculos que deixaram de existir no Bling.

## Sinalização por produto

A aba `product_supplier_status` é reconstruída ao final da reconciliação para todos os produtos conhecidos em `raw_products` e para qualquer produto encontrado nos vínculos atuais.

Cada produto recebe um dos estados:

- `none`: nenhum fornecedor vinculado;
- `single`: exatamente um fornecedor distinto;
- `multiple`: dois ou mais fornecedores distintos.

Também são registrados `supplier_count`, `primary_supplier_id`, `primary_link_id`, a regra utilizada, `updated_at` e `run_id`.

## Regra de fornecedor principal

A propriedade de script `BLING_PRIMARY_SUPPLIER_RULE` define a regra usada quando há um ou mais vínculos. O padrão é `marked_default`.

Valores suportados:

- `marked_default`: prioriza o vínculo marcado como `padrao` no Bling e usa o menor `link_id` como desempate determinístico;
- `lowest_purchase_price`: prioriza o menor `precoCompra` e usa o vínculo padrão/menor `link_id` como desempate;
- `lowest_cost_price`: prioriza o menor `precoCusto` e usa o vínculo padrão/menor `link_id` como desempate;
- `lowest_supplier_id`: prioriza o menor ID técnico de fornecedor e usa o vínculo padrão/menor `link_id` como desempate.

Nas regras de preço e custo, campo ausente ou inválido não é convertido em
zero e fica depois de qualquer valor numérico válido. Isso evita selecionar
como mais barato um vínculo cujo preço não foi informado.

Uma regra não suportada bloqueia a execução antes da coleta.

## Checkpoint e retomada

O checkpoint fica em `BLING_PRODUCT_SUPPLIERS_SYNC_CHECKPOINT` e contém apenas metadados operacionais: identificador da execução, página seguinte, contagens, fase, regra e timestamps.

A execução possui duas fases:

1. `fetch`: coleta e persiste páginas de `/produtos/fornecedores`;
2. `reconcile`: troca a visão bruta pela fotografia completa da execução e reconstrói o status por produto.

Se uma página falhar, a página anterior permanece confirmada e a próxima tentativa recomeça da mesma página. Se a reconciliação final falhar, o checkpoint permanece na fase `reconcile`, permitindo repetir somente a etapa final sem baixar novamente todas as páginas.

Ao concluir, o checkpoint é removido e somente um resumo seguro é gravado em `BLING_LAST_PRODUCT_SUPPLIERS_SYNC_RUN`.

## Execução manual

No Apps Script:

```javascript
runProductSuppliersSync(false)
```

Para iniciar uma nova reconciliação descartando somente o checkpoint atual:

```javascript
runProductSuppliersSync(true)
```

O `reset` não apaga a fotografia confirmada anterior. Os vínculos parciais de uma execução interrompida só substituem a fotografia anterior depois que a nova reconciliação é concluída.

A rotina também respeita `BLING_EXECUTION_BUDGET_MS`. Ao atingir a margem
segura, salva a página atual e retorna `execution_budget_reached` para retomada.

## Segurança e observabilidade

Logs e retornos operacionais incluem apenas contagens, fase, página, regra, códigos de erro e identificador de execução. IDs de produtos, fornecedores, SKUs e descrições não são incluídos nos logs da sincronização.
