#!/usr/bin/env node
// npm run auth                 -> mostra o link de autorização
// npm run auth -- "<endereço>" -> conclui com o endereço http://localhost/?code=... do navegador
import { finishAuth, startAuth } from "./sources/googleAuth.js";

const arg = process.argv[2];
if (!arg) {
  console.log("Abra este link, entre com a conta dona do canal e aceite as permissões de leitura:\n");
  console.log(await startAuth());
  console.log('\nO navegador vai para um endereço http://localhost/?... que não carrega. Copie esse endereço e rode:\n  npm run auth -- "<endereço>"');
} else {
  const t = await finishAuth(arg);
  console.log(`Autorizado. Escopos: ${t.scope}\nRefresh token salvo: ${t.refresh_token ? "sim" : "não"}`);
}
