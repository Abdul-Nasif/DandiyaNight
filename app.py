import os, io, re, uuid, secrets, base64
from functools import wraps
from flask import (Flask, render_template, request, redirect, url_for,
                   session, jsonify, abort)
from dotenv import load_dotenv
from supabase import create_client, Client
import qrcode
import qrcode.image.svg
import secrets
from collections import defaultdict
from time import monotonic
from threading import Lock

_RATE_LOCK = Lock()
_VERIFY_HITS = defaultdict(list)          # ip -> [timestamps]
VERIFY_WINDOW = 60                        # seconds
VERIFY_MAX    = 20                        # requests per window per IP

def rate_limited(ip: str) -> bool:
    now = monotonic()
    with _RATE_LOCK:
        hits = [t for t in _VERIFY_HITS[ip] if now - t < VERIFY_WINDOW]
        if len(hits) >= VERIFY_MAX:
            _VERIFY_HITS[ip] = hits
            return True
        hits.append(now)
        _VERIFY_HITS[ip] = hits
        return False

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY") or secrets.token_hex(32)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 MB

SUPABASE_URL  = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY  = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "")
BUCKET = "payment-screenshots"

sb: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

PRICE, FEE, TOTAL = 159, 0, 159

# -----------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------


ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"   # Crockford base32, 32 symbols
REF_LEN  = 16                                    # 32^16 = 2^80

def gen_ref_code() -> str:
    for _ in range(30):
        body = "".join(secrets.choice(ALPHABET) for _ in range(REF_LEN))
        code = "DN-" + "-".join(body[i:i+4] for i in range(0, REF_LEN, 4))
        # e.g. DN-K7QF-2XBM-9TRH-4WPZ
        r = sb.table("registrations").select("id").eq("ref_code", code).limit(1).execute()
        if not r.data:
            return code
    raise RuntimeError("Could not generate unique ref")

def make_qr_svg(data: str) -> str:
    factory = qrcode.image.svg.SvgPathImage
    img = qrcode.make(data, image_factory=factory, box_size=10, border=1)
    buf = io.BytesIO(); img.save(buf)
    return buf.getvalue().decode("utf-8")

def login_required(f):
    @wraps(f)
    def wrapper(*a, **kw):
        if not session.get("admin"):
            return redirect(url_for("admin_login"))
        return f(*a, **kw)
    return wrapper

def save_screenshot(data_url: str, ref_code: str):
    """Takes 'data:image/jpeg;base64,...' → uploads to Storage → returns path."""
    if not data_url:
        return None
    m = re.match(r"^data:image/(png|jpe?g|webp);base64,(.+)$", data_url)
    if not m:
        raise ValueError("Invalid screenshot payload")
    ext = "jpg" if m.group(1).lower() in ("jpeg", "jpg") else m.group(1).lower()
    raw = base64.b64decode(m.group(2))
    if len(raw) > 5 * 1024 * 1024:
        raise ValueError("Screenshot must be under 5 MB")
    path = f"{ref_code}/{uuid.uuid4().hex}.{ext}"
    sb.storage.from_(BUCKET).upload(
        path, raw,
        {"content-type": f"image/{ext}", "upsert": "true"}
    )
    return path

# -----------------------------------------------------------------
# Public pages
# -----------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html",
                           price=PRICE, fee=FEE, total=TOTAL)

# -----------------------------------------------------------------
# Register API — called by the front-end at the end of the 3-step form
# -----------------------------------------------------------------
@app.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json(silent=True) or {}

    required = ["name","roll","phone","email","branch","year","utr","screenshot"]
    missing = [k for k in required if not str(data.get(k, "")).strip()]
    if missing:
        return jsonify(ok=False, error="Missing: " + ", ".join(missing)), 400

    name   = data["name"].strip()
    roll   = data["roll"].strip().upper()
    phone  = re.sub(r"\D", "", data["phone"])[:10]
    email  = data["email"].strip()
    branch = data["branch"].strip()
    year   = data["year"].strip()
    utr    = re.sub(r"\D", "", data["utr"])[:12]

    if not re.fullmatch(r"[6-9]\d{9}", phone):
        return jsonify(ok=False, error="Invalid phone number"), 400
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return jsonify(ok=False, error="Invalid email"), 400
    if not re.fullmatch(r"\d{12}", utr):
        return jsonify(ok=False, error="UTR must be 12 digits"), 400

    ref_code = gen_ref_code()

    try:
        screenshot_path = save_screenshot(data["screenshot"], ref_code)
    except Exception as e:
        return jsonify(ok=False, error=f"Screenshot upload failed: {e}"), 400

    row = {
        "ref_code": ref_code,
        "name": name, "roll": roll, "phone": phone, "email": email,
        "branch": branch, "year": year,
        "amount": TOTAL, "utr": utr,
        "screenshot_path": screenshot_path,
        "status": "pending_approval",
    }
    try:
        sb.table("registrations").insert(row).execute()
    except Exception as e:
        return jsonify(ok=False, error=f"Database error: {e}"), 500

    return jsonify(ok=True, ref=ref_code)

# -----------------------------------------------------------------
# e-Pass verification / download page
# -----------------------------------------------------------------
@app.route("/verify")
def verify_home():
    return render_template("verify.html", reg=None, error=None, qr_svg=None)

@app.route("/verify/<ref_code>")
def verify_epass(ref_code):
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "?").split(",")[0].strip()
    if rate_limited(ip):
        return render_template("verify.html", reg=None, qr_svg=None,
                               error="Too many attempts. Please wait a minute."), 429
    ref_code = ref_code.strip().upper()
    r = sb.table("registrations").select("*").eq("ref_code", ref_code).limit(1).execute()

    if not r.data:
        return render_template("verify.html", reg=None, qr_svg=None,
                               error=f"No registration found for {ref_code}."), 404

    reg = r.data[0]

    if reg["status"] != "approved":
        msg = {
            "pending_payment":  "Payment has not been submitted yet.",
            "pending_approval": "Your payment is being verified. Check back soon.",
            "rejected":         "This registration was rejected. Contact the organisers.",
        }.get(reg["status"], "This e-pass is not available.")
        return render_template("verify.html", reg=reg, qr_svg=None, error=msg)

    base = (PUBLIC_BASE_URL or request.host_url.rstrip("/"))
    verify_url = f"{base}/verify/{reg['ref_code']}"
    qr_svg = make_qr_svg(verify_url)

    return render_template("verify.html", reg=reg, qr_svg=qr_svg, error=None)

# -----------------------------------------------------------------
# Admin
# -----------------------------------------------------------------
@app.route("/admin/login", methods=["GET","POST"])
def admin_login():
    if request.method == "POST":
        if request.form.get("password") == ADMIN_PASSWORD:
            session["admin"] = True
            return redirect(url_for("admin"))
        return render_template("admin_login.html", error="Invalid password.")
    return render_template("admin_login.html", error=None)

@app.route("/admin/logout")
def admin_logout():
    session.pop("admin", None)
    return redirect(url_for("admin_login"))

@app.route("/admin")
@login_required
def admin():
    r = (sb.table("registrations")
           .select("*")
           .order("created_at", desc=True)
           .execute())
    regs = r.data or []
    stats = {
        "total":    len(regs),
        "pending":  sum(1 for x in regs if x["status"] == "pending_approval"),
        "approved": sum(1 for x in regs if x["status"] == "approved"),
        "rejected": sum(1 for x in regs if x["status"] == "rejected"),
    }
    return render_template("admin.html", regs=regs, stats=stats,
                           price=PRICE, total=TOTAL)

@app.route("/admin/screenshot/<reg_id>")
@login_required
def admin_screenshot(reg_id):
    r = sb.table("registrations").select("screenshot_path").eq("id", reg_id).limit(1).execute()
    if not r.data or not r.data[0].get("screenshot_path"):
        abort(404)
    try:
        signed = sb.storage.from_(BUCKET).create_signed_url(r.data[0]["screenshot_path"], 3600)
    except Exception as e:
        abort(500, str(e))
    url = signed.get("signedURL") or signed.get("signed_url") or signed.get("signedUrl")
    if not url and isinstance(signed.get("data"), dict):
        url = signed["data"].get("signedURL") or signed["data"].get("signed_url")
    if not url:
        abort(500, "Could not create signed URL")
    return redirect(url)

@app.route("/admin/approve/<reg_id>", methods=["POST"])
@login_required
def admin_approve(reg_id):
    from datetime import datetime, timezone
    sb.table("registrations").update({
        "status": "approved",
        "approved_at": datetime.now(timezone.utc).isoformat(),
        "notes": None,
    }).eq("id", reg_id).execute()
    return jsonify(ok=True, status="approved")

@app.route("/admin/reject/<reg_id>", methods=["POST"])
@login_required
def admin_reject(reg_id):
    notes = (request.get_json(silent=True) or {}).get("notes", "")
    sb.table("registrations").update({
        "status": "rejected", "notes": notes
    }).eq("id", reg_id).execute()
    return jsonify(ok=True, status="rejected")

@app.route("/admin/epass/<reg_id>")
@login_required
def admin_epass(reg_id):
    """Same e-pass renderer, but accessible via admin session."""
    r = sb.table("registrations").select("*").eq("id", reg_id).limit(1).execute()
    if not r.data:
        abort(404)
    reg = r.data[0]
    if reg["status"] != "approved":
        abort(400, "Registration not approved yet")
    base = PUBLIC_BASE_URL or request.host_url.rstrip("/")
    qr_svg = make_qr_svg(f"{base}/verify/{reg['ref_code']}")
    return render_template("verify.html", reg=reg, qr_svg=qr_svg, error=None, admin=True)

if __name__ == "__main__":
    app.run(debug=True, port=5000)