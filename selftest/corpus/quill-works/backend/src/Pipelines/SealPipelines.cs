using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;

namespace Quill.Works.Pipelines
{
    public class Seal
    {
        public bool Halt { get; set; }
        public bool Stop { get; set; }
    }

    public interface ISealStep
    {
        Task<bool> Run(Seal seal);
    }

    public interface ISealLedgerRepository
    {
        Task SaveRejected(Seal seal);
        Task SaveSealed(Seal seal);
    }

    public class WaxStep : ISealStep
    {
        public async Task<bool> Run(Seal seal)
        {
            if (seal.Halt) return false;
            return true;
        }
    }

    public class StampStep : ISealStep
    {
        public async Task<bool> Run(Seal seal)
        {
            if (seal.Stop)
            {
                return false;
            }
            return true;
        }
    }

    public interface ISealPipeline
    {
        Task<bool> Run(Seal seal);
    }

    public class SealPipeline : ISealPipeline
    {
        private readonly List<ISealStep> _steps = new List<ISealStep>();
        private readonly ISealLedgerRepository _ledger;

        public SealPipeline(ISealLedgerRepository ledger)
        {
            _ledger = ledger;
        }

        public void RegisterStep(ISealStep step)
        {
            _steps.Add(step);
        }

        public async Task<bool> Run(Seal seal)
        {
            foreach (var s in _steps)
            {
                if (!await s.Run(seal))
                {
                    await Audit(seal);
                    return false;
                }
            }

            await _ledger.SaveSealed(seal);
            return true;
        }

        private async Task Audit(Seal seal)
        {
            await _ledger.SaveRejected(seal);
        }
    }

    public interface ITwinStopPipeline
    {
        Task<bool> Run(Seal seal);
    }

    public class TwinStopPipeline : ITwinStopPipeline
    {
        private readonly List<ISealStep> _steps = new List<ISealStep>();

        public void RegisterStep(ISealStep step)
        {
            _steps.Add(step);
        }

        public async Task<bool> Run(Seal seal)
        {
            foreach (var s in _steps)
            {
                await s.Run(seal);
                if (seal.Halt) return false;
                if (seal.Stop) return false;
            }

            return true;
        }
    }

    public interface ISweepPipeline
    {
        Task Run(Seal seal);
    }

    public class SweepPipeline : ISweepPipeline
    {
        private readonly List<ISealStep> _steps = new List<ISealStep>();

        public void RegisterStep(ISealStep step)
        {
            _steps.Add(step);
        }

        public async Task Run(Seal seal)
        {
            foreach (var s in _steps)
            {
                await s.Run(seal);
            }
        }
    }

    public static class SealRegistrations
    {
        public static void Add(IServiceCollection services)
        {
            services.AddScoped<ISealPipeline>(ctx =>
            {
                var pipeline = new SealPipeline(ctx.GetRequiredService<ISealLedgerRepository>());
                pipeline.RegisterStep(ctx.GetRequiredService<WaxStep>());
                pipeline.RegisterStep(ctx.GetRequiredService<StampStep>());
                return pipeline;
            });
            services.AddScoped<ISweepPipeline>(ctx =>
            {
                var pipeline = new SweepPipeline();
                pipeline.RegisterStep(ctx.GetRequiredService<WaxStep>());
                pipeline.RegisterStep(ctx.GetRequiredService<StampStep>());
                return pipeline;
            });
            services.AddScoped<ITwinStopPipeline>(ctx =>
            {
                var pipeline = new TwinStopPipeline();
                pipeline.RegisterStep(ctx.GetRequiredService<StampStep>());
                pipeline.RegisterStep(ctx.GetRequiredService<WaxStep>());
                return pipeline;
            });
        }
    }
}
