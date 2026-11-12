# Arena Arte Luta

Plataforma para operação de campeonatos da Arena Arte Luta: eventos, categorias, inscrições, rodas, juízes, votação por bandeiras, Cante Comigo por notas, resultados e telões públicos.

## Rodar localmente

1. Instale Node.js 20 ou superior.
2. Copie `.env.example` para `.env.local` e preencha `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Execute `npm install` e `npm run dev`.
4. Antes de publicar, execute `npm run lint`, `npm test` e `npm run build`.

## Configuração obrigatória do Supabase

O deploy da Vercel **não executa SQL**. No Supabase, abra **SQL Editor** e execute, na ordem numérica, todas as migrations de:

`supabase/migrations/001_initial.sql` até `supabase/migrations/036_prevent_repeated_event_songs.sql` em uma instalação nova. Em produção, aplique somente as migrations pendentes; não repita todas as migrations em uma base com dados. As migrations `034`, `035` e `036` acrescentam, respectivamente, o gerenciamento seguro de juízes/telões encerrados, o registro financeiro opcional e a proteção contra músicas repetidas no mesmo evento.

Em especial, as migrations `013` a `018` são necessárias para login de juízes, gestão de acessos, criação de eventos, votação segura e Cante Comigo.

No provedor Google de Authentication:

- Habilite **Google**;
- Cadastre a URL pública em **Site URL** e em **Redirect URLs**;
- Inclua `https://SEU-DOMINIO/auth/complete` como URL de retorno;
- Use apenas as chaves públicas no navegador. Nunca exponha a `service_role`.

Para conferir as funções críticas depois de aplicar o SQL:

```sql
select to_regprocedure('public.create_event_with_competitions(text,text,timestamptz,text,text,text[])');
select to_regprocedure('public.request_judge_access()');
select to_regprocedure('public.review_judge_application(uuid,boolean)');
select to_regprocedure('public.finalize_match(uuid)');
select to_regprocedure('public.homologate_scoring_results(uuid)');
```

Todas devem retornar o nome da função, nunca `null`.

## Fluxo operacional no dia do evento

1. Entre com a conta Google administradora e crie o evento.
2. Escolha Campeonato Interno, Festival Mirim e/ou Cante Comigo. Eles podem ocorrer juntos no mesmo evento, mantendo categorias e resultados separados.
3. Cadastre categorias e participantes.
4. Em **Liberação de juízes**, aprove os pedidos feitos em “Sou juiz e quero solicitar acesso”.
5. Em cada evento, abra **Juízes e rodas** e designe os juízes aprovados. Para confrontos por bandeiras, associe cada juiz à competição, categoria e roda.
6. Para bandeiras, designe pelo menos três juízes ativos, crie o confronto e inicie a disputa. O resultado só pode ser confirmado quando todos os juízes designados tiverem votado; o telão não mostra votos por cor enquanto a votação estiver aberta.
7. Para Cante Comigo, abra **Avaliações Cante Comigo** ou **Notas e apresentações**, defina os critérios, gere a fila por categoria, abra uma apresentação por vez e conclua somente depois das fichas de todos os juízes ativos. A classificação usa a **média normalizada de 0 a 10**, independentemente da quantidade de juízes. Para musicalidade, é necessário pelo menos um juiz ativo. Alterações de critérios preservam as avaliações anteriores e usam os critérios aplicáveis às novas fichas.
8. Confira a classificação em **Resultados** e publique apenas depois de homologar todos os inscritos.
9. Em **Telões ao vivo**, crie uma sessão da modalidade correta e abra o link público no monitor. Para musicalidade, não é necessário criar rodas. Abra a apresentação para chamar o participante e inicie o cronômetro apenas quando ele começar a cantar.
10. Na página do evento, configure e salve o formulário público. Ative o link e defina o status como **Inscrições abertas**. O formulário exibe as músicas escolhidas e impede uma música repetida nas novas inscrições pelo link.
11. Se desejar, registre as receitas, despesas e observações financeiras em **Configurações** do evento. São valores manuais, não cobranças automáticas; deixe em branco os valores desconhecidos.
12. Depois de resolver todas as apresentações e confrontos pendentes, use **Finalizar evento e gerar PDF**. O encerramento é definitivo; ele desativa os telões do evento e preserva os registros. Em **Eventos → Eventos já realizados**, consulte o histórico e baixe o PDF organizado ou o PDF original.

## Regras de segurança aplicadas

- O acesso da plataforma é feito com Google; a rota antiga de redefinição de senha volta ao login.
- Juízes aprovados entram diretamente no painel de avaliação; administradores e organizadores usam o painel operacional.
- Um voto de bandeira só é aceito para a competição, categoria, roda e competidor corretos.
- A finalização de bandeiras exige no mínimo três juízes ativos e votos de todos eles.
- Critérios, fichas e notas do Cante Comigo são gravados por funções seguras do banco; cada juiz só envia a própria ficha.
- Eventos, participantes e resultados são filtrados pela organização do usuário.

## Publicação na Vercel

1. Envie a branch `main` ao GitHub e importe o repositório na Vercel.
2. Cadastre `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` em Production, Preview e Development.
3. Publique com o comando padrão `npm run build`.
4. Depois do deploy, atualize as Redirect URLs do Supabase com o domínio final.

## Ensaio recomendado antes de sábado

Faça uma rodada completa com uma conta administradora, três contas de juiz e um telão em outro dispositivo: crie uma categoria, cadastre dois participantes, designe os três juízes, registre os votos, confirme o resultado e confira o telão. Se Cante Comigo estiver no programa, repita o ensaio com uma categoria, um ou mais juízes, uma apresentação e uma classificação gerada. Faça os ensaios em um evento de teste, separado dos dados oficiais.

## Conexão e recuperação

O aplicativo depende de internet para salvar dados e atualizar os outros dispositivos. O aviso de navegador offline não representa uma confirmação de disponibilidade do Supabase. Após uma falha durante uma inscrição ou nota, confira se a operação foi gravada antes de repeti-la. As telas de recuperação permitem tentar carregar novamente sem ocultar a falha.

## Verificação técnica

- `npm test`: testes de pontuação, relações de participantes, geração de PDF e proteção/recuperação da API de encerramento (API com banco simulado).
- `npm run lint` e `npm run build`: validação de código, tipos e compilação para produção.
- `npm audit` e `npm audit --omit=dev`: auditoria de dependências completa e somente de produção.
- `supabase/validar_032_033.sql`: teste transacional de inscrições e encerramento, com `ROLLBACK` no fim. Não troque por `COMMIT`: o teste contém dados temporários.
- `supabase/validar_034.sql` e `supabase/validar_035.sql`: testes transacionais de escala, remoção de acesso, telões e resumo financeiro; também terminam em `ROLLBACK`.
- `supabase/aplicar_037.sql`: remove automaticamente o acesso operacional de juízes ao finalizar um evento e limpa permissões que restaram de eventos já encerrados. Execute no SQL Editor do Supabase; contas/perfis ficam preservados somente para manter a autoria das notas, votos e relatórios históricos. O acesso de administrador não é alterado.
- `supabase/aplicar_038.sql`: adiciona a autorização e designação do juiz em uma única ação administrativa, além de excluir solicitações/acessos sem apagar a autoria do histórico. Execute depois da atualização 037.

Os testes automatizados não substituem um ensaio autenticado no evento de teste com organização, juiz e telão em dispositivos diferentes.
