FROM node:16 as builder

COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile

COPY . .

RUN yarn build:bot

COPY package.json ./dist

FROM public.ecr.aws/lambda/nodejs:16 as runner

COPY --from=builder ./dist .
COPY --from=builder ./node_modules ./node_modules
COPY --from=builder ./abis ./abis
COPY --from=builder ./artifacts ./artifacts
COPY --from=builder ./typechain ./typechain

CMD ["src/handlers/botHandler.handler"]
