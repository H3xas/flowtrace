using System.Threading;
using System.Threading.Tasks;
using Quill.Works.Queue;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace Quill.Works.Controllers
{
    [ApiController]
    [Route("glazes/v1")]
    public class GlazeController : ControllerBase
    {
        private readonly IKilnQueue _queue;
        private readonly IGlazeStore _store;
        private readonly IGlazeScheduler _scheduler;

        public GlazeController(IKilnQueue queue, IGlazeStore store, IGlazeScheduler scheduler)
        {
            _queue = queue;
            _store = store;
            _scheduler = scheduler;
        }

        [HttpPost("fire")]
        public async Task<IActionResult> Fire()
        {
            await _queue.QueueWork(async token =>
            {
                await _store.Fire(token);
            });
            return Accepted();
        }

        [HttpPost("cool")]
        public async Task<IActionResult> Cool()
        {
            await _queue.QueueWork(token => _store.Cool(token));
            return Accepted();
        }

        [HttpPost("seal")]
        public async Task<IActionResult> Seal()
        {
            await _queue.QueueWork(SealLater);
            return Accepted();
        }

        [HttpPost("polish")]
        public IActionResult Polish()
        {
            _scheduler.Schedule(() => _store.Polish());
            return Accepted();
        }

        private async ValueTask SealLater(CancellationToken token)
        {
            await _store.Seal(token);
        }
    }

    public static class QueueRegistrations
    {
        public static void Add(IServiceCollection services)
        {
            services.AddSingleton<IKilnQueue, KilnQueue>();
            services.AddSingleton<IGlazeStore, GlazeStore>();
        }
    }
}
