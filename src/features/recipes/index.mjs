// Backend feature plugin: GPU sniping priority queue + session recipes + post-acquire pipeline.
import { runAction } from "../../run.mjs";
import { createRecipeStore, normalizeHardware, normalizeRecipeInput } from "./store.mjs";
import { createSnipeQueue, normalizeTargets, targetLabel } from "./snipe.mjs";
import { runPostAcquirePipeline } from "./pipeline.mjs";

function makeSessionName(prefix) {
  const clean = String(prefix || "colab")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "colab";
  return `${clean}-${Date.now().toString(36).slice(-4)}`;
}

export function createRecipesFeature(deps = {}) {
  const runColab = deps.runAction || runAction;
  let store = null;
  let snipeQueue = null;
  let activeCtx = null;

  async function triggerPipeline({ session, recipe, snipeJobId = null, vaultEnvVars = null }) {
    if (!recipe) return null;
    const onProgress = (prog) => {
      if (snipeJobId && snipeQueue) snipeQueue.setPipeline(snipeJobId, prog);
      activeCtx?.pushEvent("recipes:pipeline", { snipeJobId, ...prog });
    };
    const onBackgroundJob = (jobPayload) => {
      activeCtx?.bus?.emit("jobs:submit", jobPayload);
      activeCtx?.pushEvent("recipes:submit-job", jobPayload);
    };
    const result = await runPostAcquirePipeline({
      session,
      recipe,
      vaultEnvVars,
      onProgress,
      onBackgroundJob,
      deps: deps.pipelineDeps || {},
    });
    if (snipeJobId && snipeQueue) snipeQueue.setPipeline(snipeJobId, result);
    activeCtx?.pushEvent("recipes:pipeline-done", { snipeJobId, ...result });
    return result;
  }

  return {
    id: "recipes",

    init(ctx) {
      activeCtx = ctx;
      store = createRecipeStore(ctx.storage("recipes"));
      snipeQueue = createSnipeQueue({
        run: runColab,
        now: deps.now,
        random: deps.random,
        minIntervalSec: deps.minIntervalSec,
        minGapSec: deps.minGapSec,
        onChange(snap) {
          ctx.pushEvent("recipes:snipe", snap);
        },
        onAcquired(snap, rawJob) {
          ctx.pushEvent("recipes:acquired", {
            snipeId: snap.id,
            session: snap.acquired.session,
            hardware: snap.acquired.hardware,
            label: snap.acquired.label,
            elapsedSec: snap.acquired.elapsedSec,
            recipeId: snap.recipeId,
          });
          if (rawJob.recipe) {
            triggerPipeline({
              session: snap.acquired.session,
              recipe: rawJob.recipe,
              snipeJobId: snap.id,
            }).catch(() => {});
          }
        },
      });
    },

    async handleRoutes(req, res, url, ctx) {
      const sendJson = ctx.sendJson || ctx.http.sendJson;
      const readBody = ctx.readJsonBodySafe || ctx.http.readJsonBodySafe;
      const p = url.pathname;
      const m = req.method;

      // ── Snipe Queue Routes ──
      if (m === "GET" && p === "/api/recipes/snipe") {
        sendJson(res, 200, { ok: true, jobs: snipeQueue.list() });
        return true;
      }
      if (m === "POST" && p === "/api/recipes/snipe") {
        const body = await readBody(req);
        try {
          let recipe = null;
          if (body.recipeId) recipe = store.get(body.recipeId);
          else if (body.recipe && typeof body.recipe === "object") recipe = body.recipe;
          const targets = Array.isArray(body.targets) && body.targets.length
            ? body.targets
            : (recipe?.snipe?.targets || (recipe?.hardware ? [recipe.hardware] : []));
          const job = snipeQueue.start({
            name: body.name || makeSessionName(recipe?.sessionNamePrefix || recipe?.name),
            targets,
            intervalSec: body.intervalSec ?? recipe?.snipe?.intervalSec,
            maxIntervalSec: body.maxIntervalSec ?? recipe?.snipe?.maxIntervalSec,
            maxAttempts: body.maxAttempts ?? recipe?.snipe?.maxAttempts,
            timeoutSec: body.timeoutSec ?? recipe?.snipe?.timeoutSec,
            recipeId: recipe?.id || body.recipeId || null,
            recipe,
          });
          sendJson(res, 200, { ok: true, job });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }
      const snipeActionMatch = /^\/api\/recipes\/snipe\/([^/]+)\/(pause|resume|cancel)$/.exec(p);
      if (m === "POST" && snipeActionMatch) {
        const id = decodeURIComponent(snipeActionMatch[1]);
        const action = snipeActionMatch[2];
        const job = snipeQueue[action](id);
        if (!job) {
          sendJson(res, 404, { ok: false, error: "snipe job not found or invalid state" });
        } else {
          sendJson(res, 200, { ok: true, job });
        }
        return true;
      }
      const snipeIdMatch = /^\/api\/recipes\/snipe\/([^/]+)$/.exec(p);
      if (m === "DELETE" && snipeIdMatch) {
        const id = decodeURIComponent(snipeIdMatch[1]);
        const removed = snipeQueue.remove(id);
        sendJson(res, removed ? 200 : 404, { ok: removed, error: removed ? undefined : "cannot remove active or missing job" });
        return true;
      }
      if (m === "GET" && snipeIdMatch) {
        const id = decodeURIComponent(snipeIdMatch[1]);
        const job = snipeQueue.get(id);
        sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: "snipe job not found" });
        return true;
      }

      // ── Export / Import ──
      if (m === "GET" && p === "/api/recipes/export") {
        const idsParam = url.searchParams.get("ids");
        const ids = idsParam ? idsParam.split(",").map((s) => s.trim()).filter(Boolean) : null;
        sendJson(res, 200, { ok: true, bundle: store.exportAll(ids) });
        return true;
      }
      if (m === "POST" && p === "/api/recipes/import") {
        const body = await readBody(req);
        try {
          const imported = store.importPayload(body.bundle || body);
          sendJson(res, 200, { ok: true, imported, recipes: store.list() });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }

      // ── Launch (from recipeId, inline recipe, or @guard config) ──
      if (m === "POST" && p === "/api/recipes/launch") {
        const body = await readBody(req);
        try {
          let recipe = null;
          if (body.recipeId) {
            recipe = store.get(body.recipeId);
            if (!recipe) {
              sendJson(res, 404, { ok: false, error: "recipe not found" });
              return true;
            }
          } else {
            const cfg = body.recipe || body.config || body;
            recipe = normalizeRecipeInput({
              ...cfg,
              name: cfg.name || cfg.sessionName || "Quick Launch",
            });
          }
          const sessionName = (body.sessionName || body.name || "").trim()
            || makeSessionName(recipe.sessionNamePrefix || recipe.name);
          const targets = normalizeTargets(
            Array.isArray(body.targets) && body.targets.length
              ? body.targets
              : (recipe.snipe?.targets?.length ? recipe.snipe.targets : [recipe.hardware]),
          );
          const useSnipe = body.snipe !== undefined
            ? Boolean(body.snipe)
            : Boolean(recipe.snipe?.enabled || targets.length > 1);

          if (useSnipe) {
            const job = snipeQueue.start({
              name: sessionName,
              targets: targets.length ? targets : [normalizeHardware(recipe.hardware)],
              intervalSec: body.intervalSec ?? recipe.snipe?.intervalSec,
              maxIntervalSec: body.maxIntervalSec ?? recipe.snipe?.maxIntervalSec,
              maxAttempts: body.maxAttempts ?? recipe.snipe?.maxAttempts,
              timeoutSec: body.timeoutSec ?? recipe.snipe?.timeoutSec,
              recipeId: recipe.id || null,
              recipe,
            });
            sendJson(res, 200, { ok: true, mode: "snipe", sessionName, job });
            return true;
          }

          // Immediate single-shot creation + post-acquire pipeline
          const hw = targets[0] || normalizeHardware(recipe.hardware);
          const startedAt = Date.now();
          const created = await runColab({
            type: "new",
            name: sessionName,
            gpu: hw.gpu,
            tpu: hw.tpu,
            highMem: hw.highMem,
          });
          if (!created.ok) {
            sendJson(res, 200, { ok: false, mode: "direct", sessionName, error: created.error || "colab new failed", result: created });
            return true;
          }
          const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
          ctx.pushEvent("recipes:acquired", {
            snipeId: null,
            session: sessionName,
            hardware: hw,
            label: targetLabel(hw),
            elapsedSec,
            recipeId: recipe.id || null,
          });
          const pipeline = await triggerPipeline({ session: sessionName, recipe });
          sendJson(res, 200, {
            ok: true,
            mode: "direct",
            sessionName,
            hardware: hw,
            result: created,
            pipeline,
          });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }

      // ── Post-acquire Pipeline Trigger ──
      if (m === "POST" && p === "/api/recipes/pipeline") {
        const body = await readBody(req);
        if (!body.session) {
          sendJson(res, 400, { ok: false, error: "session is required" });
          return true;
        }
        const recipe = body.recipeId ? store.get(body.recipeId) : body.recipe;
        if (!recipe) {
          sendJson(res, 404, { ok: false, error: "recipe not found" });
          return true;
        }
        const pipeline = await triggerPipeline({ session: body.session, recipe });
        sendJson(res, 200, { ok: true, pipeline });
        return true;
      }

      // ── Recipes CRUD ──
      if (m === "GET" && (p === "/api/recipes" || p === "/api/recipes/")) {
        sendJson(res, 200, { ok: true, recipes: store.list() });
        return true;
      }
      if (m === "POST" && (p === "/api/recipes" || p === "/api/recipes/")) {
        const body = await readBody(req);
        try {
          const recipe = store.create(body);
          sendJson(res, 201, { ok: true, recipe });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }
      const dupMatch = /^\/api\/recipes\/([^/]+)\/duplicate$/.exec(p);
      if (m === "POST" && dupMatch) {
        const id = decodeURIComponent(dupMatch[1]);
        const body = await readBody(req);
        const recipe = store.duplicate(id, body.name);
        if (!recipe) {
          sendJson(res, 404, { ok: false, error: "recipe not found" });
        } else {
          sendJson(res, 201, { ok: true, recipe });
        }
        return true;
      }
      const expOneMatch = /^\/api\/recipes\/([^/]+)\/export$/.exec(p);
      if (m === "GET" && expOneMatch) {
        const id = decodeURIComponent(expOneMatch[1]);
        const found = store.get(id);
        if (!found) {
          sendJson(res, 404, { ok: false, error: "recipe not found" });
        } else {
          sendJson(res, 200, { ok: true, bundle: store.exportAll([id]) });
        }
        return true;
      }
      const idMatch = /^\/api\/recipes\/([^/]+)$/.exec(p);
      if (idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        if (m === "GET") {
          const recipe = store.get(id);
          sendJson(res, recipe ? 200 : 404, recipe ? { ok: true, recipe } : { ok: false, error: "recipe not found" });
          return true;
        }
        if (m === "PUT") {
          const body = await readBody(req);
          try {
            const recipe = store.update(id, body);
            sendJson(res, recipe ? 200 : 404, recipe ? { ok: true, recipe } : { ok: false, error: "recipe not found" });
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message });
          }
          return true;
        }
        if (m === "DELETE") {
          const deleted = store.remove(id);
          sendJson(res, deleted ? 200 : 404, { ok: deleted, error: deleted ? undefined : "recipe not found" });
          return true;
        }
      }

      return false;
    },

    shutdown() {
      snipeQueue?.shutdown();
    },
  };
}

export const feature = createRecipesFeature();
