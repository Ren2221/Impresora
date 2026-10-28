"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
const DEFAULT_PRINTERS = { "1": "Impresora 1" };
const MAX_PRINTERS = 4;
const MAX_SHEETS_PER_ORDER = 350;
const ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".txt",
  ".doc", ".docx", ".odt", ".rtf", ".xls", ".xlsx", ".ppt", ".pptx"
]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function defaultState() {
  return { printers: DEFAULT_PRINTERS, orders: [] };
}

function readState(file) {
  if (!fs.existsSync(file)) return defaultState();
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!state || typeof state !== "object" || !state.printers ||
      typeof state.printers !== "object" || Array.isArray(state.printers) || !Array.isArray(state.orders)) {
    throw new Error("El archivo de datos no tiene un formato válido.");
  }
  if (Object.hasOwn(state, "tarjetasDemo")) {
    delete state.tarjetasDemo;
    saveState(file, state);
  }
  return state;
}

function saveState(file, state) {
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(request, limit) {
  const header = Number(request.headers["content-length"]);
  if (Number.isFinite(header) && header > limit) throw new HttpError(413, "El cuerpo de la solicitud es demasiado grande.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, "El cuerpo de la solicitud es demasiado grande.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new HttpError(400, "El JSON enviado no es válido.");
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "La ruta contiene un identificador inválido.");
  }
}

function orderResponse(order) {
  return {
    id: order.id,
    creado: order.creado,
    impresora: order.impresora,
    nombre: order.nombre,
    paginas: order.paginas,
    copias: order.copias,
    color: order.color,
    papel: order.papel || "comun",
    tamano: order.tamano || "A4",
    total: order.total,
    pagoConfirmado: order.pagoConfirmado === true ||
      (order.pagoConfirmado === undefined && order.estado !== "esperando_pago"),
    hojasImpresas: order.hojasImpresas || 0,
    estado: order.estado,
    error: order.error || ""
  };
}

function countPages(extension, buffer) {
  if (extension === ".pdf") {
    const text = buffer.toString("latin1");
    let pages = 0;
    for (const match of text.matchAll(/\/Type\s*\/Page(?![s\w])/g)) pages += 1;
    if (pages) return pages;
    let count = 1;
    for (const match of text.matchAll(/\/Count\s+(\d+)/g)) {
      const candidate = Number(match[1]);
      if (Number.isSafeInteger(candidate)) count = Math.max(count, candidate);
    }
    return count;
  }
  if (extension === ".txt") {
    return Math.max(1, Math.ceil(buffer.toString("utf8").split("\n").length / 45));
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(extension)) return 1;
  const bytesPerPage = {
    ".doc": 25000, ".docx": 18000, ".odt": 18000, ".rtf": 25000,
    ".xls": 30000, ".xlsx": 25000, ".ppt": 120000, ".pptx": 90000
  }[extension] || 25000;
  return Math.max(1, Math.ceil(buffer.length / bytesPerPage));
}

function cleanFilename(filename) {
  const basename = path.basename(filename.replace(/\\/g, "/"));
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
  return cleaned || "archivo";
}

function createApplicationServer(options) {
  const settings = options || {};
  const dataDir = path.resolve(settings.dataDir || path.join(ROOT, "data"));
  const uploadDir = path.join(dataDir, "uploads");
  const stateFile = path.join(dataDir, "database.json");
  const adminPassword = settings.adminPassword || process.env.ADMIN_PASSWORD || crypto.randomBytes(24).toString("base64url");
  const maxUploadBytes = settings.maxUploadBytes || 50 * 1024 * 1024;
  const printDurationMs = Math.max(1, Math.min(settings.printDurationMs ?? 5000, 5000));
  fs.mkdirSync(uploadDir, { recursive: true });
  const state = readState(stateFile);
  const printTimers = new Map();

  function persist() {
    saveState(stateFile, state);
  }

  const interruptedOrders = state.orders.filter(function(order) {
    return order.estado === "imprimiendo";
  });
  interruptedOrders.forEach(function(order) {
    order.estado = "error";
    order.error = "La impresión se interrumpió al reiniciar el servidor.";
  });
  if (interruptedOrders.length) persist();

  function requireAdmin(request) {
    if (!safeEqual(request.headers["x-clave"] || "", adminPassword)) {
      throw new HttpError(401, "Clave de administrador incorrecta.");
    }
  }

  function findOrder(id) {
    const order = state.orders.find(function(item) { return item.id === id; });
    if (!order) throw new HttpError(404, "No encontramos ese pedido.");
    return order;
  }

  function printerIsBusy(id) {
    return state.orders.some(function(order) {
      return order.impresora === id && order.estado === "imprimiendo";
    });
  }

  function printerStatuses() {
    const statuses = {};
    for (const id of Object.keys(state.printers)) {
      statuses[id] = printerIsBusy(id) ? "imprimiendo" : "disponible";
    }
    return statuses;
  }

  function stopPrint(id) {
    const timer = printTimers.get(id);
    if (timer) clearTimeout(timer);
    printTimers.delete(id);
  }

  function schedulePrint(order) {
    stopPrint(order.id);
    order.estado = "imprimiendo";
    order.hojasImpresas = 0;
    order.error = "";
    persist();
    const totalSheets = order.paginas * order.copias;
    function printNextSheet() {
      const timer = setTimeout(function() {
        const current = state.orders.find(function(item) { return item.id === order.id; });
        if (!current) {
          printTimers.delete(order.id);
          return;
        }
        current.hojasImpresas = (current.hojasImpresas || 0) + 1;
        if (current.hojasImpresas >= totalSheets) {
          current.estado = "listo";
          printTimers.delete(order.id);
        }
        try {
          persist();
        } catch (error) {
          current.estado = "error";
          current.error = "No se pudo guardar el estado del pedido.";
          printTimers.delete(order.id);
          console.error("No se pudo guardar el pedido:", error);
          return;
        }
        if (current.estado === "imprimiendo") printNextSheet();
      }, printDurationMs);
      timer.unref();
      printTimers.set(order.id, timer);
    }
    printNextSheet();
  }

  async function handleApi(request, response, url) {
    const pathname = url.pathname;
    const method = request.method;

    if (method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && pathname === "/api/config") {
      sendJson(response, 200, {
        precios: { bn: 500, color: 600 },
        modo: "demo",
        moneda: "$",
        maxImpresoras: MAX_PRINTERS,
        capacidadMaximaHojas: MAX_SHEETS_PER_ORDER,
        impresoras: state.printers,
        estadosImpresoras: printerStatuses()
      });
      return;
    }

    if (method === "POST" && pathname === "/api/pedidos") {
      const contentType = request.headers["content-type"] || "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
        throw new HttpError(415, "Envía el archivo como multipart/form-data.");
      }
      const body = await readBody(request, maxUploadBytes + 1024 * 1024);
      let form;
      try {
        const webRequest = new Request("http://localhost/api/pedidos", {
          method: "POST",
          headers: { "content-type": contentType },
          body,
          duplex: "half"
        });
        form = await webRequest.formData();
      } catch {
        throw new HttpError(400, "No se pudo leer el formulario de carga.");
      }
      const upload = form.get("archivo");
      if (!upload || typeof upload.arrayBuffer !== "function") {
        throw new HttpError(400, "Selecciona un archivo para cargar.");
      }
      if (upload.size < 1) throw new HttpError(400, "El archivo está vacío.");
      if (upload.size > maxUploadBytes) throw new HttpError(413, "El archivo supera el límite de 50 MB.");
      const printerId = String(form.get("impresora") || "").trim();
      if (!Object.hasOwn(state.printers, printerId)) throw new HttpError(400, "La impresora seleccionada no existe.");
      const filename = cleanFilename(upload.name || "archivo");
      const extension = path.extname(filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) throw new HttpError(415, "Ese formato de archivo no se puede imprimir.");
      const fileBuffer = Buffer.from(await upload.arrayBuffer());
      const pages = countPages(extension, fileBuffer);
      if (pages > MAX_SHEETS_PER_ORDER) {
        throw new HttpError(400, "El pedido supera el máximo de " + MAX_SHEETS_PER_ORDER + " hojas por impresora.");
      }
      if (printerIsBusy(printerId)) throw new HttpError(409, "La impresora seleccionada está imprimiendo. Intenta de nuevo cuando esté disponible.");
      const id = crypto.randomUUID();
      const storedName = id + extension;
      const filePath = path.join(uploadDir, storedName);
      fs.writeFileSync(filePath, fileBuffer, { flag: "wx" });
      const order = {
        id,
        creado: new Date().toISOString(),
        impresora: printerId,
        nombre: filename,
        archivo: storedName,
        paginas: pages,
        copias: 1,
        color: false,
        papel: "comun",
        tamano: "A4",
        total: 0,
        pagoConfirmado: false,
        hojasImpresas: 0,
        estado: "esperando_pago",
        error: ""
      };
      state.orders.push(order);
      try {
        persist();
      } catch (error) {
        state.orders.pop();
        fs.rmSync(filePath, { force: true });
        throw error;
      }
      sendJson(response, 200, { id: order.id, paginas: order.paginas, nombre: order.nombre });
      return;
    }

    const orderMatch = pathname.match(/^\/api\/pedidos\/([^/]+)(?:\/(confirmar|pagar))?$/);
    if (orderMatch) {
      const id = decodeSegment(orderMatch[1]);
      const action = orderMatch[2];
      const order = findOrder(id);
      if (method === "GET" && !action) {
        sendJson(response, 200, orderResponse(order));
        return;
      }
      if (method === "POST" && action === "confirmar") {
        if (order.estado !== "esperando_pago") throw new HttpError(409, "El pedido ya no se puede modificar.");
        const payload = parseJson(await readBody(request, 16 * 1024));
        if (typeof payload.color !== "boolean") throw new HttpError(400, "Indica si la impresión es a color.");
        const copies = Number(payload.copias);
        if (!Number.isInteger(copies) || copies < 1 || copies > 99) throw new HttpError(400, "La cantidad de copias debe estar entre 1 y 99.");
        if (order.paginas * copies > MAX_SHEETS_PER_ORDER) {
          throw new HttpError(400, "El pedido supera el máximo de " + MAX_SHEETS_PER_ORDER + " hojas por impresora.");
        }
        const paper = payload.papel === undefined ? "comun" : payload.papel;
        const paperSize = payload.tamano === undefined ? "A4" : payload.tamano;
        if (!["comun", "fotografico"].includes(paper)) throw new HttpError(400, "El tipo de papel seleccionado no es válido.");
        if (!["A4", "A3"].includes(paperSize)) throw new HttpError(400, "El tamaño de papel seleccionado no es válido.");
        const paperMultiplier = (paper === "fotografico" ? 2 : 1) * (paperSize === "A3" ? 2 : 1);
        order.color = payload.color;
        order.copias = copies;
        order.papel = paper;
        order.tamano = paperSize;
        order.total = order.paginas * copies * (payload.color ? 600 : 500) * paperMultiplier;
        persist();
        sendJson(response, 200, { total: order.total });
        return;
      }
      if (method === "POST" && action === "pagar") {
        if (order.estado !== "esperando_pago" || order.total < 1) {
          throw new HttpError(409, "Confirma primero las opciones de impresión.");
        }
        if (order.paginas * order.copias > MAX_SHEETS_PER_ORDER) {
          throw new HttpError(409, "El pedido supera el máximo de " + MAX_SHEETS_PER_ORDER + " hojas por impresora.");
        }
        const payload = parseJson(await readBody(request, 16 * 1024));
        const cardNumber = typeof payload.numero === "string" ? payload.numero : "";
        const cardholder = typeof payload.titular === "string" ? payload.titular.trim() : "";
        const expiration = typeof payload.vencimiento === "string" ? payload.vencimiento : "";
        const securityCode = typeof payload.codigo === "string" ? payload.codigo : "";
        const expirationMatch = expiration.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
        const expirationDate = expirationMatch ?
          new Date(Number(expirationMatch[1]), Number(expirationMatch[2]), 0) : null;
        const expirationValid = expirationDate &&
          expirationDate >= new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        if (!/^\d{12,19}$/.test(cardNumber) || !/^[\p{L}\p{M} ]{1,100}$/u.test(cardholder) ||
            !expirationValid || !/^\d{3,4}$/.test(securityCode)) {
          throw new HttpError(400, "Completa los datos de la tarjeta ficticia con un número, titular, vencimiento y código válidos.");
        }
        if (printerIsBusy(order.impresora)) {
          throw new HttpError(409, "La impresora seleccionada está imprimiendo. Espera a que termine antes de pagar.");
        }
        order.pagoConfirmado = true;
        order.estado = "pagado";
        try {
          persist();
        } catch (error) {
          order.pagoConfirmado = false;
          order.estado = "esperando_pago";
          throw error;
        }
        schedulePrint(order);
        sendJson(response, 200, { ok: true, modo: "demo" });
        return;
      }
    }

    if (pathname.startsWith("/api/admin/")) requireAdmin(request);

    if (method === "GET" && pathname === "/api/admin/pedidos") {
      sendJson(response, 200, state.orders.filter(function(order) {
        return order.pagoConfirmado === true;
      }).sort(function(a, b) {
        return b.creado.localeCompare(a.creado);
      }).map(orderResponse));
      return;
    }

    const adminOrderMatch = pathname.match(/^\/api\/admin\/pedidos\/([^/]+)(?:\/reimprimir)?$/);
    if (adminOrderMatch && method === "DELETE" && !pathname.endsWith("/reimprimir")) {
      const id = decodeSegment(adminOrderMatch[1]);
      const index = state.orders.findIndex(function(order) { return order.id === id; });
      if (index < 0) throw new HttpError(404, "No encontramos ese pedido.");
      const order = state.orders[index];
      state.orders.splice(index, 1);
      try {
        persist();
      } catch (error) {
        state.orders.splice(index, 0, order);
        throw error;
      }
      stopPrint(id);
      if (order.archivo) fs.rmSync(path.join(uploadDir, order.archivo), { force: true });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && adminOrderMatch && pathname.endsWith("/reimprimir")) {
      const id = decodeSegment(adminOrderMatch[1]);
      const order = findOrder(id);
      if (order.pagoConfirmado === false) {
        throw new HttpError(409, "No se puede reimprimir una compra sin pago confirmado.");
      }
      if (order.paginas * order.copias > MAX_SHEETS_PER_ORDER) {
        throw new HttpError(409, "El pedido supera el máximo de " + MAX_SHEETS_PER_ORDER + " hojas por impresora y no se puede reimprimir.");
      }
      if (printerIsBusy(order.impresora)) {
        throw new HttpError(409, "La impresora seleccionada ya está imprimiendo otro pedido.");
      }
      schedulePrint(order);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === "/api/admin/impresoras" && method === "GET") {
      sendJson(response, 200, {
        impresoras: state.printers,
        estadosImpresoras: printerStatuses(),
        maxImpresoras: MAX_PRINTERS,
        capacidadMaximaHojas: MAX_SHEETS_PER_ORDER
      });
      return;
    }

    if (pathname === "/api/admin/impresoras" && (method === "POST" || method === "PUT")) {
      const payload = parseJson(await readBody(request, 16 * 1024));
      const id = String(payload.id || "").trim();
      const name = String(payload.nombre || "").trim();
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) {
        throw new HttpError(400, "El identificador solo puede incluir letras, números, guiones y guiones bajos.");
      }
      if (!name || name.length > 100) throw new HttpError(400, "El nombre debe tener entre 1 y 100 caracteres.");
      if (method === "POST") {
        if (Object.hasOwn(state.printers, id)) throw new HttpError(409, "Ya existe una impresora con ese identificador.");
        if (Object.keys(state.printers).length >= MAX_PRINTERS) {
          throw new HttpError(409, "No se pueden configurar más de " + MAX_PRINTERS + " impresoras.");
        }
        state.printers[id] = name;
      } else {
        if (!Object.hasOwn(state.printers, id)) throw new HttpError(404, "No encontramos esa impresora.");
        state.printers[id] = name;
      }
      persist();
      sendJson(response, method === "POST" ? 201 : 200, { id, nombre: name });
      return;
    }

    const printerMatch = pathname.match(/^\/api\/admin\/impresoras\/([^/]+)$/);
    if (printerMatch && method === "PUT") {
      const id = decodeSegment(printerMatch[1]);
      const payload = parseJson(await readBody(request, 16 * 1024));
      const name = String(payload.nombre || "").trim();
      if (!Object.hasOwn(state.printers, id)) throw new HttpError(404, "No encontramos esa impresora.");
      if (!name || name.length > 100) throw new HttpError(400, "El nombre debe tener entre 1 y 100 caracteres.");
      state.printers[id] = name;
      persist();
      sendJson(response, 200, { id, nombre: name });
      return;
    }
    if (printerMatch && method === "DELETE") {
      const id = decodeSegment(printerMatch[1]);
      if (!Object.hasOwn(state.printers, id)) throw new HttpError(404, "No encontramos esa impresora.");
      if (Object.keys(state.printers).length === 1) throw new HttpError(409, "Debe quedar al menos una impresora configurada.");
      if (printerIsBusy(id)) throw new HttpError(409, "No se puede eliminar una impresora mientras está imprimiendo.");
      delete state.printers[id];
      persist();
      sendJson(response, 200, { ok: true });
      return;
    }

    throw new HttpError(404, "No encontramos esa ruta.");
  }

  async function handleRequest(request, response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    let url;
    try {
      url = new URL(request.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Método no permitido.");
      const files = {
        "/": "index.html",
        "/index.html": "index.html",
        "/admin.html": "admin.html",
        "/imprimir-aqui.html": "imprimir-aqui.html",
        "/style.css": "style.css"
      };
      const filename = files[url.pathname];
      if (!filename) throw new HttpError(404, "No encontramos esa página.");
      const file = path.join(ROOT, filename);
      const body = fs.readFileSync(file);
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(file)] || "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-cache"
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("Error procesando solicitud:", error);
      sendJson(response, status, { error: status === 500 ? "Error interno del servidor." : error.message });
    }
  }

  const server = http.createServer(function(request, response) {
    void handleRequest(request, response);
  });
  server.on("close", function() {
    for (const timer of printTimers.values()) clearTimeout(timer);
    printTimers.clear();
  });
  server.adminPassword = adminPassword;
  return server;
}

if (require.main === module) {
  const server = createApplicationServer();
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  if (!process.env.ADMIN_PASSWORD) {
    console.log("Clave de administrador generada para esta ejecución: " + server.adminPassword);
    console.log("Configura ADMIN_PASSWORD en el entorno para usar una clave persistente.");
  }
  server.listen(port, host, function() {
    console.log("Servidor listo en http://" + host + ":" + port);
  });
}

module.exports = { createApplicationServer };
