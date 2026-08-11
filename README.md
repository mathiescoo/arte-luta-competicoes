# Arena Arte Luta

Plataforma para operação de campeonatos da Arena Arte Luta: eventos, categorias, inscrições, rodas, juízes, votação por bandeiras, Cante Comigo por notas, resultados e telões públicos.

## Rodar localmente

1. Instale Node.js 20 ou superior.
2. Copie `.env.example` para `.env.local` e preencha `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Execute `npm install` e `npm run dev`.
4. Antes de publicar, execute `npm run lint`, `npm test` e `npm run build`.

## Configuração obrigatória do Supabase

O deploy da Vercel **não executa SQL**. No Supabase, abra **SQL Editor** e execute, na ordem numérica, todas as migrations de:

`supabase/migrations/001_initial.sql` até `supabase/migrations/018_scoring_workflow.sql`.

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
7. Para Cante Comigo, abra **Avaliações Cante Comigo** ou **Notas e apresentações**, defina os critérios, gere a fila por categoria, abra uma apresentação por vez e conclua somente depois das fichas de todos os juízes ativos. A classificação usa a **soma** das notas.
8. Confira a classificação em **Resultados** e publique apenas depois de homologar todos os inscritos.
9. Em **Telões ao vivo**, crie uma sessão e abra o link público no monitor. O telão atualiza automaticamente em intervalos curtos.

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

Faça uma rodada completa com uma conta administradora, três contas de juiz e um telão em outro dispositivo: crie uma categoria, cadastre dois participantes, designe os três juízes, registre os votos, confirme o resultado e confira o telão. Se Cante Comigo estiver no programa, repita o ensaio com uma categoria, três juízes, uma apresentação e uma classificação gerada.
