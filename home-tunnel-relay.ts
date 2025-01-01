import { Application, Router } from "https://deno.land/x/oak/mod.ts";
import { format } from "https://deno.land/std@0.91.0/datetime/mod.ts";


let wsLeft = undefined;
let wsRight = undefined
function log(text)
{
  console.log(format(new Date(), "yyyy-MM-dd HH:mm:ss"), text);
}

function connected(ws: WebSocket)
{
  return (ws != undefined) && (ws.readyState === WebSocket.OPEN);
}

function handleError(ev: ErrorEvent)
{
  log("Error: " + ev.message);
}

function handleConnected()
{
  log("Connected!");
}

const router = new Router();

router.get("/left", (ctx) => {
  if (!ctx.isUpgradable) {
    ctx.throw(501);
  }
  if(connected(wsLeft)) {
    log("Closing old socket");
    wsLeft.close();
    if(connected(wsRight)) { // reset pair
      wsRight.close();
    }
  }

  wsLeft = ctx.upgrade();
  wsLeft.onopen = () => {
      log("Opened Left")
  };
  wsLeft.onmessage = (m) => {
      if(connected(wsRight)) {
          log('send from Left')
          wsRight.send(m.data)
      }
  };
  wsLeft.onclose = () => log("Disconncted from client Left");
});


router.get("/right", (ctx) => {
  if (!ctx.isUpgradable) {
    ctx.throw(501);
  }
  if(connected(wsRight)) {
    log("Closing old socket");
    wsRight.close();
    if(connected(wsLeft)) { // reset pair
      wsLeft.close();
    }
  }

  wsRight = ctx.upgrade();
  wsRight.onopen = () => {
      log("Opened Right")
  };
  wsRight.onmessage = (m) => {
      if(connected(wsLeft)) {
          log('send from Right')
          wsLeft.send(m.data)
      }
  };
  wsRight.onclose = () => log("Disconncted from client Right");
});


router.get('/',(ctx)=>{
  var data = `connected Left = ${connected(wsLeft)}\n`;
  data += `connected Right = ${connected(wsRight)}\n`;
  ctx.response.body = data;
})

const app = new Application();
app.use(router.allowedMethods(), router.routes());

await app.listen({ port: 80 });
