FROM solanalabs/solana:v1.18.26

RUN apt update && \
    apt install -y nodejs npm && \
    apt clean && rm -rf /var/lib/apt/lists/*

RUN npm install -g @solana/spl-token

COPY .env /
COPY scripts/ /
COPY entrypoint.sh /

RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

CMD ["/bin/bash"]
