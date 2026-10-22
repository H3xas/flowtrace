using System.Collections.Generic;
using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Steps;

namespace Bakery.Api.Pipelines
{
    public interface IProofPipeline
    {
        Task<Dough> ProcessAsync(Dough dough);
    }

    public class ProofPipeline : IProofPipeline
    {
        private readonly List<IProofStep> _steps = new List<IProofStep>();

        public void RegisterStep(IProofStep step)
        {
            _steps.Add(step);
        }

        public async Task<Dough> ProcessAsync(Dough dough)
        {
            foreach (var step in _steps)
            {
                await step.ProcessAsync(dough);
                if (!dough.Valid) return null;
            }

            return dough;
        }
    }

    public interface ILooseProofPipeline
    {
        Task<Dough> ProcessAsync(Dough dough);
    }

    public class LooseProofPipeline : ILooseProofPipeline
    {
        private readonly List<IProofStep> _steps = new List<IProofStep>();

        public void RegisterStep(IProofStep step)
        {
            _steps.Add(step);
        }

        public async Task<Dough> ProcessAsync(Dough dough)
        {
            foreach (var step in _steps)
            {
                await step.ProcessAsync(dough);
                if (!dough.Valid) return null;
            }

            return dough;
        }
    }
}
