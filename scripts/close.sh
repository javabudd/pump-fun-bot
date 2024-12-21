#!/bin/bash

# Function to close a token account
close_account() {
    local token_account=$1
    echo "Closing token account: $token_account"
    spl-token close "$token_account"
}

# Get the list of token accounts
token_accounts=$(spl-token accounts)

# Parse the token accounts output
echo "$token_accounts" | while read -r line; do
    # Skip headers and separators
    if [[ "$line" == "Token"* || "$line" == "-----------------------------------------------------" ]]; then
        continue
    fi

    # Extract token account and balance
    token_account=$(echo "$line" | awk '{print $1}')
    balance=$(echo "$line" | awk '{print $2}')

    # Close accounts with a balance of 0
    if [[ "$balance" == "0" ]]; then
        close_account "$token_account"
    fi
done

echo "Done processing token accounts."
