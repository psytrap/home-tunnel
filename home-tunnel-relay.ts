import { Application, Router, Context } from "jsr:@oak/oak@^17.1.4";
import { format } from "jsr:@std/datetime@^0.225.3";
import { OAuth2Client } from "jsr:@cmd-johnson/oauth2-client@^2.0.0";
/*
if (import.meta.main) {
  await import {
    MemoryStore,
    Session,
  } from "https://deno.land/x/oak_sessions@v9.0.0/mod.ts";
} else {
  await import {
    MemoryStore,
    Session,
  } from "oak_sessions";
}
*/
interface SessionData {
  codeVerifier?: string;
  user?: {
    login: string;
    id: number;
  };
}

type AppState = {
  sessionId: string | null;
  session: SessionData;
};

export async function serve(port: number, app_key: string, oauth2Client: OAuth2Client, user_id: number) {
  const AUTH_REQUIRED: boolean = oauth2Client !== undefined ? true : false;
  const USER_ID: number | undefined = user_id;

  const PORT: number = port;
  const APP_SECRET_COOKIE_KEY = app_key;

  const sessions = new Map<string, SessionData>();


  let activationTimer = -1;
  let isActivated = false; // Or use a database, etc.

  let updatedSSE = false;
  let wsLeft: WebSocket | null = null;
  let wsRight: WebSocket | null = null;


  const authMiddleware = async (context: Context<AppState>, next: () => Promise<unknown>): Promise<unknown> => {
    console.log(context.state);
    if (AUTH_REQUIRED === false) {
      await next(); // User is authenticated, proceed to the route handler
    } else if (context.state.session && context.state.session.user
      && context.state.session.user.id === USER_ID) {
      await next(); // User is authenticated, proceed to the route handler
    } else {
      context.response.redirect("/login"); // Redirect to login if not authenticated
      return;
    }
  };

  function log(text: any) {
    console.log(format(new Date(), "yyyy-MM-dd HH:mm:ss"), text);
  }

  function connected(ws: WebSocket | null): boolean {
    return ws?.readyState === WebSocket.OPEN;
  }

  function handleError(ev: ErrorEvent) {
    log("Error: " + ev.message);
  }


  function handleConnected() {
    log("Connected!");
  }


  const router = new Router<AppState>();
  const app = new Application<AppState>();

  router.get("/login", async (context) => {
    const { uri, codeVerifier } = await oauth2Client.code.getAuthorizationUri();

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { codeVerifier });

    await context.cookies.set("sessionId", sessionId, {
      httpOnly: true,
      sameSite: "lax", // Or "Strict" if appropriate
      secure: context.request.secure, // Essential for HTTPS
      path: "/",
      signed: true,
    });
    console.log("/login")
    console.log(await context.cookies.get("sessionId", { signed: true }));

    /*
      const state = crypto.randomUUID();
      const { uri, codeVerifier } = await oauth2Client.code.getAuthorizationUri({
        state,
      });
  
      // Store both the state and codeVerifier in the user session
      context.state.session.flash("state", state);
      context.state.session.flash("codeVerifier", codeVerifier);
  */
    context.response.redirect(uri);
  });
  router.get("/oauth2/callback", async (context) => {
    try {
      console.log("/callback")
      /*  
        const state = context.state.session.get("state");
        if (typeof state !== "string") {
          throw new Error("invalid state");
        }
    */
      const sessionId = await context.cookies.get("sessionId", { signed: true });
      if (!sessionId) {
        throw new Error("No session found");
      }
      console.log(context.cookies);

      const session = sessions.get(sessionId);
      console.log(session);
      if (!session || typeof session.codeVerifier !== "string") {
        throw new Error("Invalid session or codeVerifier");
      }
      const codeVerifier = session.codeVerifier;
      if (typeof codeVerifier !== "string") {
        throw new Error("invalid codeVerifier");
      }
      const tokens = await oauth2Client.code.getToken(context.request.url, {
        /*state,*/
        codeVerifier,
      });
      // Use the access token to make an authenticated API request
      const userResponse = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
        },
      });
      const data = await userResponse.json();
      //console.log(data);
      if (data.id === USER_ID) {
        //context.state.session.set("login", data.login); // store the username as well
        //context.state.session.set("authenticated", true);
        //context.state.authenticated = true;

        session.user = { login: data.login, id: data.id };
        sessions.set(sessionId, session);

        context.response.redirect("/"); // Redirect to a protected route after login
      } else {
        context.response.body = `Access denied for ${data.login}! Use a valid login.`;
      }
    } catch (e) {
      console.log(e);
    }
  });

  router.get("/left", (ctx) => {
    if (!ctx.isUpgradable) {
      ctx.throw(501);
    }
    if (connected(wsLeft)) {
      log("Nulling old socket Left");
      if (wsLeft) {
        wsLeft.onmessage = null;
      }    }

    wsLeft = ctx.upgrade();
    wsLeft.onopen = () => {
      updatedSSE = true;
      log("Opened Left")
    };
    wsLeft.onmessage = (m) => {
      if (isActivated === true && connected(wsRight)) {
        log('send from Left')
        wsRight?.send(m.data)
      }
    };
    wsLeft.onclose = () => log("Disconncted from client Left");
  });


  router.get("/right", (ctx) => {
    if (!ctx.isUpgradable) {
      ctx.throw(501);
    }
    if (connected(wsRight)) {
      log("Nulling old socket Right");
      if (wsRight) {
        wsRight.onmessage = null;
      }    }

    wsRight = ctx.upgrade();
    wsRight.onopen = () => {
      log("Opened Right")
      updatedSSE = true;
    };
    wsRight.onmessage = (m) => {
      if (isActivated === true && connected(wsLeft)) {
        log('send from Right')
        wsLeft?.send(m.data)
      }
    };
    wsRight.onclose = () => log("Disconncted from client Right");
  });


  router.get("/", authMiddleware, (context: any) => {
    console.log("/");
    context.response.body = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Relay Management Panel</title>
    </head>
    <body>
      <h1>Controls:</h1>
        <button id="activate-button">Activate</button>
        <button id="activate-timer-button">Activate for two hours</button>
        <button id="deactivate-button">Deactivate</button>
      <h1>Current Status:</h1>
      <pre id="status-display">Waiting for update...</pre>
      ${AUTH_REQUIRED === true ? `<br/><a href="/logout">logout</a>` : ''}
      <script>
        const statusDisplay = document.getElementById("status-display");
        const activateButton = document.getElementById("activate-button");
        const activateTimerButton = document.getElementById("activate-timer-button");
        const deactivateButton = document.getElementById("deactivate-button");

        // Function to update the displayed status
        function updateStatus(data) {
          statusDisplay.textContent = JSON.stringify(data, null, 2);
        }

        const eventSource = new EventSource("/sse/status");
        eventSource.onmessage = (event) => {
            const newData = JSON.parse(event.data);
            updateStatus(newData)
        }
        eventSource.onerror = (error) => {
            console.error("SSE error:", error);
            updateStatus({error: "connection lost"});
        }
        activateButton.addEventListener("click", () => {
            postActivation(true, false);
        });
        deactivateButton.addEventListener("click", () => {
            postActivation(false, false);
        });
        activateTimerButton.addEventListener("click", () => {
            postActivation(true, true);
        });
        function postActivation(activate, timer) {
            fetch("/activation", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ active: activate, timer: timer })
            })
            .then(response => {
                if (!response.ok) {
                    console.error("Error toggling status:", response.status);
                }
            })
            .catch((error) => {
                console.error("Error toggling status:", error);
            });
        };
      </script>
    </body>
    </html>
  `;
    context.response.headers.set("Content-Type", "text/html");
  });


  router.post("/activation", authMiddleware, async (context: any) => {
    try {
      const body = await context.request.body;
      const { active, timer } = await body.json();
      if (typeof active !== 'boolean' || typeof timer !== 'boolean') {
        context.response.status = 400; // Bad Request
        context.response.body = { error: "The 'active' and 'timer' property must be a boolean." };
        return;
      }
      console.log(`Activation and timer state: ${active}, ${timer}`);
      isActivated = active;
      if (timer === true) {
        activationTimer = 2 * 3600;
      } else {
        activationTimer = -1;
      }
      updatedSSE = true;
      context.response.status = 200; // OK
      context.response.body = { message: "Activation status updated." };
    } catch (error) {
      console.error("Error handling /activation:", error);
      context.response.status = 500; // Internal Server Error
      context.response.body = { error: "An error occurred during activation." };
    }
  });

  router.get("/sse/status", async (context) => {

    console.log("SSE");
    const headers = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    context.response.headers = headers;

    const target = await context.sendEvents();
    target.dispatchMessage({ left: connected(wsLeft), right: connected(wsRight), activated: isActivated, timer: activationTimer });
    let counter = 0;
    const intervalId = setInterval(() => {
      if (counter > 0 && updatedSSE === false) {
        counter -= 1;
      } else {
        counter = 10;
        updatedSSE = false;
        target.dispatchMessage({ left: connected(wsLeft), right: connected(wsRight), activated: isActivated, timer: activationTimer });
      }
    }, 1000);
    target.addEventListener("close", (evt) => {
      clearInterval(intervalId);
    });

  });

  router.get("/logout", authMiddleware, async (context: Context<AppState>) => {
    if (AUTH_REQUIRED === true && context.state.sessionId) {
      sessions.delete(context.state.sessionId); // Remove session from store
      context.cookies.delete("sessionId", { path: "/", signed: true }); // Clear the cookie
      context.response.body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Logout Message</title>
</head>
<body>
  <p>Logged out!</p>
  <p>Separately logout from <a href="https://github.com/">GitHub</a>.</p>
</body>
</html>`;
    } else {
      context.response.status = 500; // Internal Server Error
      context.response.body = { error: "An error occurred during logout." };
    }
  });


  // Add a key for signing cookies
  app.keys = [APP_SECRET_COOKIE_KEY];

  // Set up the session middleware
  /*
  const sessionStore = new MemoryStore();
  app.use(Session.initMiddleware(sessionStore, {
    cookieSetOptions: {
      httpOnly: true,
      sameSite: "lax",
      // Enable for when running outside of localhost
      // secure: true,
      signed: true,
    },
    cookieGetOptions: {
      signed: true,
    },
    expireAfterSeconds: 60 * 60 * 3,
  }));


  app.use(async (ctx, next) => {
    ctx.state.authenticated = ctx.state.session.get("authenticated") || false;
    await next();
  });
  */

  app.use(async (ctx, next) => {
    console.log("app.use()");
    const sessionId = await ctx.cookies.get("sessionId", { signed: true });
    ctx.state.sessionId = sessionId || null;
    ctx.state.session = sessionId ? sessions.get(sessionId) || {} : {};
    console.log(ctx.state);

    await next();
  });


  app.use(router.allowedMethods(), router.routes());

  const timerId = setInterval(() => {
    if (activationTimer > 0) {
      activationTimer -= 1;
    }
    if (activationTimer === 0) {
      isActivated = false;
      activationTimer = -1;
    }
  }, 1000);

  await app.listen({ port: PORT });

  clearInterval(timerId);
}

/**
 * For Standalone testing
 */
async function standalone() {
  const STANDALONE_USER_ID = parseInt(Deno.env.get("USER_ID") ?? "-1"); // https://api.github.com/users/<your_github_user_name>
  const HOST: string | undefined = Deno.env.get("HOST"); // my-subdoman.deno.dev
  const CLIENT_ID: string | undefined = Deno.env.get("CLIENT_ID") ?? "<Client ID>";
  const CLIENT_SECRET: string | undefined = Deno.env.get("CLIENT_SECRET") ?? "<Client Secret>";

  const REDIRECT_URI = `https://${HOST}/oauth2/callback`;
  const oauth2Client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    authorizationEndpointUri: "https://github.com/login/oauth/authorize",
    tokenUri: "https://github.com/login/oauth/access_token",
    redirectUri: REDIRECT_URI,
    defaults: {
      scope: "read:user",
    },
  });
  const APP_KEY = Deno.env.get("SECRET_COOKIE_KEY") ?? crypto.randomUUID(); // random alphanum
  const STANDALONE_PORT = 80;
  await serve(STANDALONE_PORT, APP_KEY, oauth2Client, STANDALONE_USER_ID);
}

if (import.meta.main) {
  await standalone();
}
