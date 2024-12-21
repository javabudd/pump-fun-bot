FROM solanalabs/solana:v1.18.26

RUN apt update && \
    apt install -y nodejs npm && \
    apt clean && rm -rf /var/lib/apt/lists/*

RUN npm install -g @solana/spl-token

COPY scripts/close.sh /

ENTRYPOINT ["/bin/bash"]
