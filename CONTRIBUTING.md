# Contribuindo

## Fluxo mínimo

1. Crie uma branch vinculada ao item do Jira, por exemplo `feature/PRA-10-repository-skeleton`.
2. Faça alterações pequenas e rastreáveis.
3. Execute `npm run check`.
4. Confirme que nenhum segredo ou payload comercial foi incluído.
5. Abra um pull request informando item do Jira, testes e evidências.

## Convenção de commits

Use mensagens objetivas:

```text
feat(PRA-10): cria esqueleto do Apps Script
docs(PRA-7): registra decisão de carga histórica
fix(PRA-11): corrige renovação de token
```

## Dados e segredos

Não use dados reais em testes, documentação, issues ou pull requests. Exemplos devem ser sintéticos ou anonimizados.
