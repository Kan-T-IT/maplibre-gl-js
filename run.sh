#!/bin/bash

# Define the function to run when a file in src/ changes
run_build_dev() {
    bun build-dev
}

# Watch for changes in the src/ folder
fswatch -0 src/ | while read -d "" event
do
    # Call the function to run build-dev
    run_build_dev
done