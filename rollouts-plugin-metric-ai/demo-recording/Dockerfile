FROM mcr.microsoft.com/playwright:v1.58.2-noble

ARG TARGETARCH
ARG KUBECTL_VERSION=v1.32.3
ARG ARGO_ROLLOUTS_VERSION=v1.8.2

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    espeak-ng \
    ffmpeg \
    gh \
    unzip \
  && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Install kubectl & kubectl-argo-rollouts
RUN ARCH="${TARGETARCH:-amd64}" \
  && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" -o /usr/local/bin/kubectl \
  && chmod +x /usr/local/bin/kubectl \
  && curl -fsSL "https://github.com/argoproj/argo-rollouts/releases/download/${ARGO_ROLLOUTS_VERSION}/kubectl-argo-rollouts-linux-${ARCH}" -o /usr/local/bin/kubectl-argo-rollouts \
  && chmod +x /usr/local/bin/kubectl-argo-rollouts

WORKDIR /workspace
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

ENTRYPOINT ["bun", "run"]
CMD ["record-demo.ts"]
