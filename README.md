# End-to-end encrypted collaborative documents, using Automerge and Signal

## Dependencies

You will need Docker to build and run our Docker container. Our [Dockerfile](Dockerfile) lists our internal dependencies (including node and signal-cli). To generate plots from the raw benchmark data, you will need [uv](https://docs.astral.sh/uv/).

## Benchmarking

We provide bash scripts `b{1,2,3,4}.sh` for each of our four experiments. To run a single experiment, use `./netprofile.sh <slow|fast|off>` to restrict the network to our "slow" or "fast" setting, or to use the network to its fully capacity (`off`). Then, run one of `./b1.sh`, `./b2.sh`, `./b3.sh`, `./b4.sh`. The result of the benchmark will be printed in the console, and will also be written to `benchmark_data/*.csv`.

We also provide a unified bash scripts `bench.sh <slow|fast|off>`, which runs all four experiments in sequence. 

## (alternative) Benchmarking manually

### Setup

Setup the docker container with

```bash
docker-compose up --build -d
./netprofile.sh [slow|fast|off] # Sets latency and bandwidth in container
docker exec -it e2ee-cd /bin/bash  # Open shell in Docker container
```

Start the signal-cli daemon with

```bash
signal-cli --config=./signal-data/signal-multiaccount daemon --http  
```

If you want to run the benchmark for only one user, use

```bash
signal-cli --config=./signal-data/signal-multiaccount -a=$NUMBER daemon --http 
```

For usability, you might want to `source .env`, which exports the variables `ACCOUNT_1` and `ACCOUNT_2`.

If you get a warning `WARN  MultiAccountManager - Ignoring $NUMBER: User is not registered. (NotRegisteredException)`: register the signal number as follows (see [signal-cli Wiki](https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning))):

 ```bash
signal-cli --config=./signal-data/signal-multiaccount link -n "${OPTIONAL_DEVICE_NAME} | tee >(xargs -L 1 qrencode -t utf8)
```
Then scan the QR code with a primary device where you are already logged in with the Signal account for `$NUMBER`.
Alternatively, if your device does not recognize the QR code shown by qrencode, get the link by running `signal-cli --config=./signal-data/signal-multiaccount link -n "${OPTIONAL_DEVICE_NAME}"` and paste the `sgnl://linkdevice?uuid=...` link in your favorite QR code generator (e.g., search for "qr code for $LINK" on DuckDuckGo).

### Running benchmarks

In another tab, `cd crdt-benchmarks/benchmarks/automerge` and run `npm start` to run all benchmarks.

To run a specific benchmark, run `npm start -- $BENCH_NAME`, where `$BENCH_NAME` is one of `b1-signal`, `b2-signal`, `b3-signal`, `b4-large-edits`. 

## Generating the plots

We use [uv](https://docs.astral.sh/uv/) to manage Python dependencies. To run the Jupyter notebooks, run the following command to automatically read the data in `benchmark_data` and generate plots in `benchmark_plots`.

```bash
uv run --with jupyter jupyter execute analysis-1.ipynb
uv run --with jupyter jupyter execute analysis_2-3.ipynb
uv run --with jupyter jupyter execute analysis_4.ipynb
```

Alternatively, make sure that you have the correct Python version specified in [.python-version](.python-version), install the dependencies listed in [pyproject.toml](pyproject.toml) along with `jupyter` using your favorite Python package manager, and launch `jupyter`.
