using System;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace Quill.Works.Queue
{
    public interface IKilnQueue
    {
        ValueTask QueueWork(Func<CancellationToken, ValueTask> work);
    }

    public class KilnQueue : IKilnQueue
    {
        private readonly Channel<Func<CancellationToken, ValueTask>> _channel;

        public KilnQueue(Channel<Func<CancellationToken, ValueTask>> channel)
        {
            _channel = channel;
        }

        public async ValueTask QueueWork(Func<CancellationToken, ValueTask> work)
        {
            await _channel.Writer.WriteAsync(work);
        }
    }

    public class KilnWorker : BackgroundService
    {
        private readonly IKilnQueue _queue;

        public KilnWorker(IKilnQueue queue)
        {
            _queue = queue;
        }

        protected override Task ExecuteAsync(CancellationToken stoppingToken)
        {
            return Task.CompletedTask;
        }
    }

    public interface IGlazeScheduler
    {
        void Schedule(Action job);
    }

    public interface IGlazeStore
    {
        ValueTask Fire(CancellationToken token);
        ValueTask Cool(CancellationToken token);
        ValueTask Seal(CancellationToken token);
        void Polish();
    }

    public class GlazeStore : IGlazeStore
    {
        public ValueTask Fire(CancellationToken token) { return ValueTask.CompletedTask; }
        public ValueTask Cool(CancellationToken token) { return ValueTask.CompletedTask; }
        public ValueTask Seal(CancellationToken token) { return ValueTask.CompletedTask; }
        public void Polish() { }
    }
}
