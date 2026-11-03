import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../../..'),client=path.join(repo,'src/web/client');
const {createServer}=await import(pathToFileURL(path.join(client,'node_modules/vite/dist/node/index.js')).href);
const server=await createServer({configFile:false,root:here,resolve:{alias:[{find:'/client',replacement:path.join(client,'src')}]},plugins:[{name:'local-sprites',configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/sprites/'))return next();const file=path.resolve(repo,'src/web','.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(path.join(repo,'src/web/sprites')+path.sep)){res.statusCode=403;res.end();return;}try{res.setHeader('Content-Type',file.endsWith('.json')?'application/json':file.endsWith('.webp')?'image/webp':'image/png');res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end();}});}}],server:{host:'127.0.0.1',port:Number(process.env.PORT||5212),strictPort:true,fs:{allow:[here,repo]}}});
await server.listen();console.log(server.resolvedUrls.local[0]);
