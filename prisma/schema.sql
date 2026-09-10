-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "botName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "phone_number_id" TEXT,
    "verify_token" TEXT,
    "whatsapp_token" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "trial_ends_at" TIMESTAMPTZ(6),
    "business_type" TEXT NOT NULL DEFAULT 'general',
    "products" JSONB NOT NULL DEFAULT '[]',
    "delivery_fee" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "bundle_offer" JSONB,
    "tone" TEXT NOT NULL DEFAULT 'ودود ومهني',
    "languages" JSONB NOT NULL DEFAULT '["ar","en"]',
    "features" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "items" JSONB NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payment_url" TEXT,
    "proof" JSONB,
    "stripe_session_id" TEXT,
    "cart_reminded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(6),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "service" TEXT,
    "day" TEXT,
    "slot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "reminded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "ref_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "phones" JSONB NOT NULL,
    "results" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_users" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "resetCode" TEXT,
    "resetExpires" TIMESTAMP(3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kv_store" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "kv_store_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tenant_id" TEXT,
    "phone" TEXT,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_tenant_id_phone_created_at_idx" ON "messages"("tenant_id", "phone", "created_at");

-- CreateIndex
CREATE INDEX "orders_tenant_id_created_at_idx" ON "orders"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_cart_reminded_at_created_at_idx" ON "orders"("status", "cart_reminded_at", "created_at");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_created_at_idx" ON "appointments"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "appointments_status_reminded_at_created_at_idx" ON "appointments"("status", "reminded_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_tenant_id_day_slot_key" ON "appointments"("tenant_id", "day", "slot");

-- CreateIndex
CREATE INDEX "ratings_tenant_id_idx" ON "ratings"("tenant_id");

-- CreateIndex
CREATE INDEX "broadcasts_tenant_id_created_at_idx" ON "broadcasts"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_users_tenantId_phone_key" ON "tenant_users"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "events_tenant_id_type_created_at_idx" ON "events"("tenant_id", "type", "created_at");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_users" ADD CONSTRAINT "tenant_users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

