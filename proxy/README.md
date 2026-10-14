# Serviço Gemini protegido para o Documentador de Sistemas

Este serviço recebe imagens do aplicativo, monta o prompt de documentação e chama o Gemini. A chave Gemini fica no servidor, nunca no `.exe`. Cada destinatário usa um código de acesso diferente. Os códigos não ficam gravados no aplicativo; o servidor guarda apenas seus hashes SHA-256.

O código está pronto para hospedar no Google Cloud Run, que fornece um endereço HTTPS sem manter um computador próprio ligado. **Ainda é necessário criar/configurar o projeto Google Cloud e publicar o serviço.** O serviço não funciona para outros computadores antes dessa publicação.

## Preparação

1. Crie ou selecione um projeto Google Cloud com faturamento habilitado e ative Cloud Run, Cloud Build, Artifact Registry e Secret Manager. Confira os custos e configure um alerta de orçamento.
2. No Secret Manager, crie um segredo chamado `documentador-gemini-key` com o valor da sua chave Gemini. Não coloque a chave em arquivos enviados ao Cloud Run nem na linha de comando. Conceda à identidade de execução do serviço acesso de leitura a esse segredo.
3. Para cada pessoa, execute `node gerar-codigo.js` nesta pasta. Guarde o **hash** exibido para a configuração do serviço e envie à pessoa somente o **código** correspondente por um canal privado. Nunca inclua códigos no `.exe`.

## Publicação pelo gcloud

Na pasta `proxy`, com `gcloud` autenticado, substitua `SEU_PROJETO` e `HASH_GERADO`:

```powershell
gcloud run deploy documentador-gemini-proxy --source . --project SEU_PROJETO --region southamerica-east1 --allow-unauthenticated --set-secrets GEMINI_API_KEY=documentador-gemini-key:1 --set-env-vars GEMINI_MODEL=gemini-3.5-flash-lite,DOCUMENTADOR_PROXY_TOKEN_HASHES=HASH_GERADO --max-instances 1 --concurrency 2 --timeout 120s
```

Se houver mais de um destinatário, configure `DOCUMENTADOR_PROXY_TOKEN_HASHES` com os hashes separados por vírgula na configuração do Cloud Run; ao usar `gcloud`, prefira um arquivo de variáveis de ambiente para não confundir a vírgula da lista com a separação de argumentos. A URL HTTPS fornecida pelo Cloud Run vai no campo **Endereço do serviço** do aplicativo.

`--allow-unauthenticated` deixa a URL acessível pela internet, mas as rotas de geração exigem um código de acesso. O serviço limita cada código a 120 gerações por hora e 300 por dia e aceita no máximo duas chamadas simultâneas por instância. Esses limites são mantidos em memória e podem reiniciar ou se multiplicar entre instâncias; use também quotas e alertas de faturamento do Google Cloud/Gemini.

Para revogar o acesso de uma pessoa, remova seu hash de `DOCUMENTADOR_PROXY_TOKEN_HASHES` e publique uma nova revisão. Para trocar a chave Gemini, atualize o segredo e publique a versão apropriada. Se a chave for comprometida, revogue-a no Google AI Studio após ativar uma substituta.

## Referências oficiais

- [Segurança das chaves Gemini](https://ai.google.dev/gemini-api/docs/api-key)
- [Publicar código-fonte no Cloud Run](https://docs.cloud.google.com/run/docs/deploying-source-code)
- [Usar Secret Manager com Cloud Run](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
- [Preços do Cloud Run](https://cloud.google.com/run/pricing)
