using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Pipelines;

namespace Bakery.Api.Services
{
    public interface IGlazeService
    {
        Task<Glaze> GlazeAsync(GlazeRequest request);
        Task<Glaze> SprinkleAsync(GlazeRequest request);
        Task<Glaze> CrumbAsync(GlazeRequest request);
        Task<Glaze> FrostAsync(GlazeRequest request);
        Task<FillOrder> FillAsync(GlazeRequest request);
        Task<TopOrder> TopAsync(GlazeRequest request);
    }

    public class GlazeService : IGlazeService
    {
        private readonly IGlazePipeline _glazePipeline;
        private readonly ISprinklePipeline _sprinklePipeline;
        private readonly ICrumbPipeline _crumbPipeline;
        private readonly IFrostingPipeline _frostingPipeline;
        private readonly IFillPipeline _fillPipeline;
        private readonly ITopPipeline _topPipeline;

        public GlazeService(
            IGlazePipeline glazePipeline,
            ISprinklePipeline sprinklePipeline,
            ICrumbPipeline crumbPipeline,
            IFrostingPipeline frostingPipeline,
            IFillPipeline fillPipeline,
            ITopPipeline topPipeline)
        {
            _glazePipeline = glazePipeline;
            _sprinklePipeline = sprinklePipeline;
            _crumbPipeline = crumbPipeline;
            _frostingPipeline = frostingPipeline;
            _fillPipeline = fillPipeline;
            _topPipeline = topPipeline;
        }

        public async Task<Glaze> GlazeAsync(GlazeRequest request)
        {
            var glaze = new Glaze(request);
            return await _glazePipeline.ProcessAsync(glaze);
        }

        public async Task<Glaze> SprinkleAsync(GlazeRequest request)
        {
            var glaze = new Glaze(request);
            return await _sprinklePipeline.ProcessAsync(glaze);
        }

        public async Task<Glaze> CrumbAsync(GlazeRequest request)
        {
            var glaze = new Glaze(request);
            return await _crumbPipeline.ProcessAsync(glaze);
        }

        public async Task<Glaze> FrostAsync(GlazeRequest request)
        {
            var glaze = new Glaze(request);
            return await _frostingPipeline.ProcessAsync(glaze);
        }

        public async Task<FillOrder> FillAsync(GlazeRequest request)
        {
            return await _fillPipeline.ProcessAsync(request);
        }

        public async Task<TopOrder> TopAsync(GlazeRequest request)
        {
            return await _topPipeline.ProcessAsync(request);
        }
    }
}
