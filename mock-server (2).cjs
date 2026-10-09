const http = require("http");
const crypto = require("crypto");
const { Pool, types } = require("pg");

const PORT = process.env.PORT || 8080;
const CODE = "123456";
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";

types.setTypeParser(1082, (value) => value);
types.setTypeParser(1114, (value) => value.replace(" ", "T"));
types.setTypeParser(1700, (value) => parseFloat(value));
types.setTypeParser(20, (value) => Number(value));

const required = ["SUPABASE_DB_HOST", "SUPABASE_DB_PORT", "SUPABASE_DB_NAME", "SUPABASE_DB_USERNAME", "SUPABASE_DB_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);

if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const pool = new Pool({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USERNAME,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 5
});

const db = (text, params = []) => pool.query(text, params).then((result) => result.rows);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function vendorKey(username) {
  let hash = 2166136261;
  for (const char of String(username).trim().toLowerCase()) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
}

async function setup() {
  await db("CREATE SCHEMA IF NOT EXISTS mock");
  await db(`CREATE TABLE IF NOT EXISTS mock.users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    mobile_number TEXT,
    address TEXT,
    enabled BOOLEAN NOT NULL DEFAULT FALSE
  )`);
  await db(`CREATE TABLE IF NOT EXISTS mock.products (
    product_id SERIAL PRIMARY KEY,
    vendor_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    stock_quantity INTEGER NOT NULL,
    condition TEXT NOT NULL,
    listing_date DATE NOT NULL DEFAULT CURRENT_DATE,
    image_url TEXT
  )`);
  await db(`CREATE TABLE IF NOT EXISTS mock.orders (
    order_id TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    subtotal NUMERIC(10, 2) NOT NULL,
    service_fee NUMERIC(10, 2) NOT NULL,
    total NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);
  await db(`CREATE TABLE IF NOT EXISTS mock.reviews (
    review_id TEXT PRIMARY KEY,
    reviewer_id TEXT,
    vendor_id TEXT,
    product_id TEXT,
    rating INTEGER NOT NULL,
    comment TEXT,
    review_date TIMESTAMP NOT NULL DEFAULT NOW()
  )`);
  await db(`CREATE TABLE IF NOT EXISTS mock.bulletins (
    bulletin_id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    posted_by TEXT,
    date_posted TIMESTAMP NOT NULL DEFAULT NOW()
  )`);
  await db(`CREATE TABLE IF NOT EXISTS mock.notifications (
    notification_id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    recipient TEXT NOT NULL,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    date_created TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

  const testUsers = [
    ["240865537", "STUDENT", "Test Student", "student@test.com"],
    ["2024/123456/07", "VENDOR", "MN Textbooks", "vendor@test.com"]
  ];

  for (const [username, role, name, email] of testUsers) {
    await db(
      `INSERT INTO mock.users (username, password_hash, role, name, email, enabled)
       VALUES ($1, $2, $3, $4, $5, TRUE) ON CONFLICT DO NOTHING`,
      [username, hashPassword("password123"), role, name, email]
    );
  }

  const [{ count }] = await db("SELECT COUNT(*)::int AS count FROM mock.products");

  if (count === 0) {
    const vendor = vendorKey("2024/123456/07");
    await db(
      `INSERT INTO mock.products (vendor_id, name, description, category, price, stock_quantity, condition, listing_date, image_url) VALUES
       ($1, 'Calculus Textbook', 'Second-hand Calculus textbook in excellent condition.', 'Textbooks', 450, 2, 'used', '2026-10-02', '/images/Calculus.jpg'),
       ($1, 'Scientific Calculator', 'Casio FX 991ES scientific calculator.', 'Electronics', 350, 6, 'used', '2026-10-05', '/images/Calculator.jpg')`,
      [vendor]
    );
  }

  const [{ bulletins }] = await db("SELECT COUNT(*)::int AS bulletins FROM mock.bulletins");

  if (bulletins === 0) {
    await db(
      `INSERT INTO mock.bulletins (title, description, category, posted_by, date_posted) VALUES
       ('Student laptop sale', 'Affordable second-hand laptops at the student centre this week.', 'ANNOUNCEMENT', 'SRC', NOW() - INTERVAL '2 days'),
       ('Graphic design services', 'Logos, posters and presentation design for societies.', 'SERVICE', 'Lindiwe M.', NOW() - INTERVAL '6 days')`
    );
  }
}

const productFields = `product_id AS "productId", vendor_id AS "vendorId", name, description, category, price,
  stock_quantity AS "stockQuantity", condition, listing_date AS "listingDate", image_url AS "imageUrl"`;
const orderFields = `order_id AS "orderId", product_name AS "productName", quantity, subtotal, service_fee AS "serviceFee", total`;
const reviewFields = `review_id AS "reviewId", reviewer_id AS "reviewerId", vendor_id AS "vendorId", product_id AS "productId", rating, comment, review_date AS "reviewDate"`;
const bulletinFields = `bulletin_id AS "bulletinId", title, description, category, posted_by AS "postedBy", date_posted AS "datePosted"`;
const notificationFields = `notification_id AS "notificationId", message, recipient, read, date_created AS "dateCreated"`;

async function stripe(path, params) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params ? new URLSearchParams(params).toString() : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Stripe request failed");
  return data;
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": typeof data === "string" ? "text/plain" : "application/json" });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

function serverError(res, path) {
  return send(res, 500, { timestamp: Date.now(), status: 500, error: "Internal Server Error", path });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

async function userFromToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer mock.")) return null;
  const username = decodeURIComponent(header.slice(12));
  const [user] = await db("SELECT username, role FROM mock.users WHERE username = $1 AND enabled", [username]);
  return user || null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : {};
  console.log(req.method, path);

  if (path === "/" || path === "/health") return send(res, 200, "ItemHive mock API is running");

  if (path === "/api/auth/register" && req.method === "POST") {
    const email = String(body.email || "").trim().toLowerCase();
    const username = String(body.identifier || "").trim();
    if (!email || !username || String(body.password || "").length < 8 || !body.name) {
      return send(res, 400, { timestamp: Date.now(), status: 400, error: "Bad Request", path });
    }
    try {
      await db(
        `INSERT INTO mock.users (username, password_hash, role, name, email, mobile_number, address, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`,
        [username, hashPassword(body.password), String(body.role || "STUDENT").toUpperCase(), body.name, email, body.mobileNumber || null, body.address || null]
      );
    } catch {
      return serverError(res, path);
    }
    console.log(`  Verification code for ${email}: ${CODE}`);
    return send(res, 201, { message: "Account created. Check your email for the verification code." });
  }

  if (path === "/api/auth/verify" && req.method === "POST") {
    const email = String(body.email || "").trim().toLowerCase();
    if (body.code !== CODE) return serverError(res, path);
    const updated = await db("UPDATE mock.users SET enabled = TRUE WHERE email = $1 RETURNING username", [email]);
    if (!updated.length) return serverError(res, path);
    return send(res, 200, { message: "Email verified. You can now log in." });
  }

  if (path === "/api/auth/resend" && req.method === "POST") {
    console.log(`  New code for ${body.email}: ${CODE}`);
    return send(res, 200, { message: "If the account exists, a new code has been sent." });
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    const [user] = await db("SELECT * FROM mock.users WHERE username = $1", [String(body.username || "").trim()]);
    if (!user || !checkPassword(String(body.password || ""), user.password_hash)) {
      return send(res, 401, { error: "Invalid username or password." });
    }
    if (!user.enabled) return send(res, 403, { error: "Please verify your email first." });
    return send(res, 200, { token: `mock.${encodeURIComponent(user.username)}`, role: user.role });
  }

  const me = await userFromToken(req);
  if (!me) return send(res, 401, "");
  const isVendor = me.role === "VENDOR" || me.role === "ADMIN";

  if (path === "/api/products" && req.method === "GET") {
    return send(res, 200, await db(`SELECT ${productFields} FROM mock.products ORDER BY product_id`));
  }

  if (path === "/api/products" && req.method === "POST") {
    if (!isVendor) return send(res, 403, "");
    try {
      const [product] = await db(
        `INSERT INTO mock.products (vendor_id, name, description, category, price, stock_quantity, condition, listing_date, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), $9) RETURNING ${productFields}`,
        [body.vendorId, body.name, body.description, body.category, body.price, body.stockQuantity, body.condition, body.listingDate || null, body.imageUrl || null]
      );
      return send(res, 200, product);
    } catch {
      return serverError(res, path);
    }
  }

  const productMatch = path.match(/^\/api\/products\/(\d+)$/);
  if (productMatch) {
    const id = Number(productMatch[1]);

    if (req.method === "GET") {
      const [product] = await db(`SELECT ${productFields} FROM mock.products WHERE product_id = $1`, [id]);
      return product ? send(res, 200, product) : send(res, 404, "");
    }

    if (!isVendor) return send(res, 403, "");

    if (req.method === "PUT") {
      try {
        const [product] = await db(
          `UPDATE mock.products SET vendor_id = $2, name = $3, description = $4, category = $5, price = $6,
           stock_quantity = $7, condition = $8, listing_date = COALESCE($9::date, listing_date), image_url = $10
           WHERE product_id = $1 RETURNING ${productFields}`,
          [id, body.vendorId, body.name, body.description, body.category, body.price, body.stockQuantity, body.condition, body.listingDate || null, body.imageUrl || null]
        );
        return product ? send(res, 200, product) : send(res, 404, "");
      } catch {
        return serverError(res, path);
      }
    }

    if (req.method === "DELETE") {
      const removed = await db("DELETE FROM mock.products WHERE product_id = $1 RETURNING product_id", [id]);
      return removed.length ? send(res, 204, "") : send(res, 404, "");
    }
  }

  if (path === "/api/order") {
    if (req.method === "POST") {
      try {
        const [order] = await db(
          `INSERT INTO mock.orders (order_id, product_name, quantity, subtotal, service_fee, total)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${orderFields}`,
          [body.orderId, body.productName, body.quantity, body.subtotal, body.serviceFee, body.total]
        );
        const [product] = await db("SELECT product_id FROM mock.products WHERE name = $1 LIMIT 1", [body.productName]);
        if (product) {
          await db("UPDATE mock.products SET stock_quantity = GREATEST(stock_quantity - $2, 0) WHERE product_id = $1", [product.product_id, body.quantity]);
        }
        return send(res, 200, order);
      } catch {
        return serverError(res, path);
      }
    }
    return send(res, 200, await db(`SELECT ${orderFields} FROM mock.orders ORDER BY created_at`));
  }

  if (path === "/api/review") {
    if (req.method === "POST") {
      try {
        const [review] = await db(
          `INSERT INTO mock.reviews (review_id, reviewer_id, vendor_id, product_id, rating, comment, review_date)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamp, NOW())) RETURNING ${reviewFields}`,
          [body.reviewId, body.reviewerId, body.vendorId, body.productId, body.rating, body.comment, body.reviewDate || null]
        );
        return send(res, 200, review);
      } catch {
        return serverError(res, path);
      }
    }
    return send(res, 200, await db(`SELECT ${reviewFields} FROM mock.reviews ORDER BY review_date DESC`));
  }

  if (path === "/api/bulletins") {
    if (req.method === "POST") {
      try {
        const [bulletin] = await db(
          `INSERT INTO mock.bulletins (title, description, category, posted_by, date_posted)
           VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, NOW())) RETURNING ${bulletinFields}`,
          [body.title, body.description, body.category, body.postedBy, body.datePosted || null]
        );
        return send(res, 200, bulletin);
      } catch {
        return serverError(res, path);
      }
    }
    return send(res, 200, await db(`SELECT ${bulletinFields} FROM mock.bulletins ORDER BY date_posted DESC`));
  }

  if (path === "/api/notification") {
    if (req.method === "PUT") {
      const [item] = await db(
        `UPDATE mock.notifications SET read = TRUE WHERE notification_id = $1 RETURNING ${notificationFields}`,
        [body.notificationId]
      );
      return item ? send(res, 200, item) : send(res, 404, "");
    }
    return send(res, 200, await db(`SELECT ${notificationFields} FROM mock.notifications ORDER BY date_created DESC`));
  }

  if (path === "/api/payments/create-checkout-session" && req.method === "POST") {
    const items = body.items || [];
    if (items.length === 0) return send(res, 400, "Cart is empty");

    let subtotal = 0;
    const description = [];

    for (const item of items) {
      const [product] = await db("SELECT name, price FROM mock.products WHERE product_id = $1", [item.productId]);
      if (!product) return send(res, 400, `Unknown product ${item.productId}`);
      if (!(item.quantity > 0)) return send(res, 400, "Invalid quantity");
      subtotal += product.price * item.quantity;
      description.push(`${item.quantity} x ${product.name}`);
    }

    const total = Math.round((subtotal * 0.8 + 15) * 100) / 100;
    const frontend = req.headers.origin || "http://localhost:5173";

    if (!STRIPE_KEY) {
      const sessionId = `cs_test_mock_${Date.now()}`;
      return send(res, 200, { url: `${frontend}/payment-success?session_id=${sessionId}`, sessionId });
    }

    try {
      const session = await stripe("checkout/sessions", {
        mode: "payment",
        success_url: `${frontend}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontend}/payment-cancel`,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "zar",
        "line_items[0][price_data][unit_amount]": String(Math.round(total * 100)),
        "line_items[0][price_data][product_data][name]": "Itemhive Store Order",
        "line_items[0][price_data][product_data][description]": description.join(", ")
      });
      return send(res, 200, { url: session.url, sessionId: session.id });
    } catch (error) {
      console.log("  Stripe error:", error.message);
      return send(res, 500, "");
    }
  }

  if (path.startsWith("/api/payments/status/")) {
    const sessionId = decodeURIComponent(path.split("/").pop());
    if (!STRIPE_KEY || sessionId.startsWith("cs_test_mock_")) return send(res, 200, "paid");
    try {
      const session = await stripe(`checkout/sessions/${encodeURIComponent(sessionId)}`);
      return send(res, 200, session.payment_status);
    } catch (error) {
      console.log("  Stripe error:", error.message);
      return send(res, 500, "error");
    }
  }

  return send(res, 404, "");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.end();

  try {
    await handle(req, res);
  } catch (error) {
    console.error("  Error:", error.message);
    if (!res.headersSent) serverError(res, req.url);
  }
});

setup()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Mock ItemHive API running on port ${PORT}, storing data in Supabase (schema "mock")`);
      console.log("Test logins (password: password123):");
      console.log("  Student: 240865537");
      console.log("  Vendor:  2024/123456/07");
      console.log(`New sign-ups: verification code is always ${CODE}`);
      console.log(STRIPE_KEY
        ? "Payments: real Stripe test checkout (use card 4242 4242 4242 4242)"
        : "Payments: simulated (set STRIPE_SECRET_KEY to use the real Stripe test page)");
    });
  })
  .catch((error) => {
    console.error("Could not connect to the database:", error.message);
    process.exit(1);
  });
