# Product Requirements Document (PRD): QR Menu & Instant Order App

## 1. Executive Summary & Goals
- **Product Name**: Digital QR Menu & Instant Order (Storefront & Console)
- **Target Audience**: Quán cà phê, nhà hàng nhỏ, tiệm salon/spa cần tối ưu quy trình gọi món/dịch vụ và thanh toán tại bàn.
- **Core Objective**: Cho phép khách hàng tự quét mã QR tại bàn để xem menu, đặt món và thanh toán VietQR tự động. Đơn hàng lập tức nổ về màn hình Bếp/Thu ngân (Console) và báo cáo doanh thu về cho Chủ quán (Owner).
- **Architecture**: Monorepo (`apps/storefront`, `apps/console`, `apps/worker`, `packages/identity`, `packages/catalog`, `packages/orders`) chạy trên nền tảng Cloudflare (D1, R2, Workers). Xem [Decision Record](./decisions/260919-post-xia-decision-record.md).

---

## 2. Target Users & User Journeys

### 2.1. Khách hàng (Customer at Table)
1. Quét mã QR tại bàn (truy cập qua `table_token` bí mật).
2. Xem Menu, chọn món, điều chỉnh số lượng và xem lại đơn hàng.
3. Bấm đặt món -> Màn hình hiển thị mã VietQR chuyển khoản PayFS tự động.
4. Chuyển khoản thành công -> Webhook nổ -> Màn hình chuyển sang trạng thái `paid` kèm Secret Link theo dõi tiến độ món ăn.

### 2.2. Nhân viên Bếp / Phục vụ (Staff / Barista)
1. Nhìn thấy đơn hàng mới nổ trên màn hình Bếp (`apps/console`) gần thời gian thực — polling 3 giây (D7), phân loại theo số bàn.
2. Bấm "Nhận đơn & Chế biến" (`preparing`) -> Bấm "Giao món" (`fulfilled`).
3. Nếu hết món hoặc khách báo sự cố: Bấm nút "Yêu cầu hoàn tiền" (`Request Refund`) kèm lý do gửi cho Owner.

### 2.3. Chủ quán (Owner)
1. Đăng nhập Operator Console bằng Google OAuth (`better-auth`).
2. Quản lý danh mục món (Thêm/Sửa/Xóa, tải ảnh món ăn lên Cloudflare R2, bật/tắt `out_of_stock`).
3. Quản lý danh sách bàn & xuất mã QR. "Xuất QR" = sinh token mới và hiển thị **đúng một lần** (DB chỉ giữ digest); token cũ còn hiệu lực thêm 15 phút để khách đang ngồi không bị ngắt giữa chừng (D17).
4. Xem báo cáo doanh thu real-time và duyệt (*Approve*) / từ chối (*Reject*) các yêu cầu hoàn tiền.

---

## 3. System Architecture & Tech Stack

- **Monorepo Structure** (D1, D3):
  - `apps/storefront`: React 19 + Vite SPA cho Khách tại bàn, deploy thành Worker riêng với origin riêng.
  - `apps/console`: React 19 + Vite SPA cho Nhân viên & Owner, phục vụ bằng chính API Worker qua `assets` binding (cùng origin với `/api`).
  - `apps/worker`: HTTP adapter + platform composition. Không chứa quy tắc nghiệp vụ.
  - `packages/identity`: user, session, membership, permission, invitation.
  - `packages/catalog`: categories, products, ảnh R2, money, tables + QR token.
  - `packages/orders`: orders, order_items, payments, refund_requests, state machine, idempotency, email outbox.
  - Chiều phụ thuộc một chiều: `orders → catalog → identity`. Package không bao giờ import app.
- **Database & Storage**: Cloudflare D1 (SQLite at Edge) & Cloudflare R2 (Image Storage). Truy cập D1 bằng **SQL viết tay** (`prepare().bind()` + `db.batch()`), migration SQL đánh số append-only — **không dùng ORM** (D2).
- **Third-Party Integrations**:
  - **PayFS**: Ghi nhận biến động số dư qua Open Banking. Webhook ký HMAC-SHA256 trên **JSON đã chuẩn hóa** (`timestamp + "." + JSON.stringify(sort khóa đệ quy)`), header `X-PayFS-Signature` / `X-PayFS-Timestamp`, hạn 5 phút (D5). Payload **không có trường nào trỏ về đơn** — khớp đơn bằng `payment_reference` trong `content` + `amount` (D18). Đối soát qua `GET /v1.1/transactions` (D6).
  - **Cloudflare Tunnel (`cloudflared`)**: chỉ dùng cho **một** lần smoke test chuyển khoản thật trước khi lên production. Vòng lặp dev hằng ngày dùng script tự ký payload bắn thẳng vào worker local (O2).
  - **better-auth**: Đăng nhập Google OAuth cho trang Console.
  - **Resend**: Tự động gửi email báo cáo doanh thu chốt ngày cho Owner và xác nhận refund.

---

## 4. Business Contracts & State Machine

### 4.1. Quy tắc nghiệp vụ cốt lõi (Business Contracts)
1. **Server-calculated Pricing**: Giá món và Tổng tiền đơn hàng bắt buộc phải do Server tính toán, tuyệt đối không tin tưởng dữ liệu gửi từ Client.
2. **Price Snapshot**: Đơn hàng lưu cố định giá trị trị tại thời điểm đặt (Snapshot), không bị thay đổi khi danh mục menu đổi giá vào ngày hôm sau.
3. **Idempotency**: Khống chế bấm trùng đơn khi khách nhấp thanh toán nhiều lần do mạng lag.
4. **Secret Link Viewing**: Khách tra cứu đơn bằng URL bí mật chứa `order_token`, không cần tạo tài khoản/đăng nhập.

### 4.2. Order Lifecycle (Vòng đời trạng thái đơn hàng)
`pending_payment` -> `paid` -> `preparing` -> `fulfilled` / `cancelled` / `refunded`

---

## 5. Data Schema Design (Cloudflare D1)

- **`categories`**: `id`, `name`, `slug`, `display_order`
- **`products`**: `id`, `category_id`, `name`, `description`, `price`, `image_url` (R2), `is_available`
- **`tables`**: `id`, `table_number` — token nằm ở bảng riêng `table_secrets` (`table_id`, `token_digest`, `created_at`, `revoked_at`), một bàn có thể có nhiều digest còn sống trong cửa sổ ân hạn (D17)
- **`orders`**: `id`, `order_code`, `payment_reference` (`QM` + 8 ký tự `[0-9A-Z]`, sinh trong code, `UNIQUE(store_id, payment_reference)` — D18), `table_id`, `status`, `total_amount`, `payment_method`, `created_at`
- **`order_items`**: `id`, `order_id`, `product_id`, `quantity`, `unit_price_snapshot`, `notes`
- **`refund_requests`**: `id`, `order_id`, `requested_by_staff_id`, `reason`, `status` (`pending`, `approved`, `rejected`)

Quy ước bắt buộc (Decision Record):
- Mọi bảng có cột `store_id` ngay từ migration đầu, giá trị hằng cho MVP (D4).
- Mọi giá trị tiền là `INTEGER` minor units (VND: `fractionDigits = 0`) — không float, không `toFixed` (D11).
- Token bàn (`table_secrets.token_digest`) và token tra cứu đơn của khách chỉ lưu **SHA-256 digest**, không lưu token thô; token đi trong URL fragment rồi gửi qua header, mọi thất bại trả 404 đồng nhất (D8, D17).
- Bảng phụ bắt buộc, chưa liệt kê ở trên: `order_idempotency`, `provider_events`, `provider_payments`, `order_email_jobs` (D10, D12).
- Biến thể món (size / topping) **không làm ở MVP** và không chặn migration đầu: cỡ ly khai báo thành món riêng, tuỳ chọn không ảnh hưởng giá dùng `order_items.notes`; mọi việc giải giá nằm trong một hàm `resolveLineItemPrice` của `catalog` để thêm `product_variants` sau chỉ là migration cộng thêm (D19).

---

## 6. Scope Lock MVP (Phạm vi tối thiểu cho 1-2 tuần)

### IN SCOPE (Làm):
- Luồng Happy Path: Quét QR -> Xem Menu -> Đặt món -> Mã VietQR -> Nổ đơn Bếp -> Đổi trạng thái Giao món.
- Phân quyền RBAC cơ bản: Staff (xử lý đơn, request refund) vs Owner (quản lý menu, duyệt refund).
- Tích hợp Webhook PayFS, R2 upload, better-auth Google OAuth, Resend Email.

### OUT OF SCOPE (Chưa làm):
- Giỏ hàng nhiều bàn / Ghép bàn phức tạp.
- Hệ thống tích điểm, voucher giảm giá, coupon.
- Tích hợp cổng thẻ visa/mastercard trực tuyến (chỉ dùng VietQR).

---

## 7. Verification & Quality Gates

- **Unit & Integration Testing (`/ak:test`)**: Kiểm thử logic tính tổng tiền, snapshot giá và chuyển đổi trạng thái đơn hàng.
- **Webhook Contract Testing**: test vector công bố của PayFS phải cho ra đúng chữ ký `86f02cef…c5e`; regex khớp `payment_reference` phải chạy trên giá trị thật do code sinh, với `content` có rác của ngân hàng bao quanh (D5, D18).
- **E2E UI Testing (`/ak:web-testing`)**: Tự động mở trình duyệt giả lập trọn vẹn luồng từ khách đặt món đến Bếp nhận đơn.
- **Security Audit (`/ak:security-scan`)**: Quét bảo mật tự động đảm bảo không bị rò rỉ PayFS Webhook Secret, Resend API Key hay OAuth Secrets.
