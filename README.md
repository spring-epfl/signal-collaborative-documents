# End-to-end encrypted collaborative documents, using Automerge and Signal

## Dependencies

### Setup dependencies
- docker


### Benchmarking dependencies

See [Dockerfile](Dockerfile)

### Plotting dependencies
- [uv](https://docs.astral.sh/uv/)

## Usage

### Build and setup

```bash
docker-compose up --build -d
./netprofile.sh [slow|fast|off] # Sets latency and bandwidth in container
docker exec -it e2ee-cd /bin/bash  # Open shell in 
```

### Benchmark

1. Start the signal-cli daemon with

```bash
signal-cli --config=./signal-data/signal-multiaccount daemon --http  
```

If you want to run the benchmark for only one user, use

```bash
signal-cli --config=./signal-data/signal-multiaccount -a=$NUMBER daemon --http 
```

For usability, you might want to `source .env`, which exports the variables `ACCOUNT_1` and `ACCOUNT_2`.

 1. If you get a warning `WARN  MultiAccountManager - Ignoring $NUMBER: User is not registered. (NotRegisteredException)`: register the signal number as follows (see [signal-cli Wiki](https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning))):

   ```bash
    signal-cli --config=./signal-data/signal-multiaccount link -n "${OPTIONAL_DEVICE_NAME} | tee >(xargs -L 1 qrencode -t utf8)
   ```

   Then scan the QR code with a primary device where you are already logged in with the Signal account for `$NUMBER`.
   Alternatively, if your device does not recognize the QR code shown by qrencode, get the link by running `signal-cli --config=./signal-data/signal-multiaccount link -n "${OPTIONAL_DEVICE_NAME}"` and paste the `sgnl://linkdevice?uuid=...` link in your favorite QR code generator (e.g., search for "qr code for $LINK" on DuckDuckGo).

2. In another tab, `cd crdt-benchmarks/benchmarks/automerge` and run `npm start` to run all benchmarks.

    To run a specific benchmark, run `npm start -- $BENCH_NAME`, where `$BENCH_NAME` is one of `b1-signal`, `b2-signal`, `b3-signal`. 

## Benchmarking

1. Build the Docker image with `docker-compose up --build -d`

## Generating the plots

We use [uv](https://docs.astral.sh/uv/) to manage Python dependencies. To run the Jupyter notebooks, run the following command to automatically read the data in `benchmark_data` and generate plots in `benchmark_plots`. 

```bash
uv run --with jupyter jupyter execute analysis-1.ipynb
uv run --with jupyter jupyter execute analysis_2-3.ipynb
```

Alternatively, make sure that you have the correct python version specified in [.python-version](.python-version), install the dependencies listed in [pyproject.toml](pyproject.toml) along with jupyter using your favourite python package manager, and launch jupyter.
